// ============================================================================
// ai-vision — 현장 사진·영상 프레임을 AI 로 분석하는 서버 프록시 (Supabase Edge Function)
//
//  왜 서버에 두나
//   · Gemini(무료) 키를 **한 곳에만** 두고 모든 사용자(접수자·전문가)가 쓰게 한다.
//   · 키가 브라우저에 나가지 않는다 → 개별 설정 없이 "바로 사용".
//
//  키는 두 곳 중 하나에서 읽는다 (DB 우선):
//   A. DB 표 public.ai_config — 관리자가 앱 ⚙ 설정에서 넣고 모델도 여기서 바꾼다 (권장)
//   B. 이 함수의 Secret GEMINI_API_KEY / GEMINI_MODEL — A 가 비었을 때 폴백
//  DB 접근은 Supabase 가 자동 주입하는 SUPABASE_SERVICE_ROLE_KEY 로 한다 (RLS 우회, 서버 전용).
//
//  배포
//   1) 대시보드 → Edge Functions → Deploy a new function → 이름 'ai-vision'
//      → 아래 코드를 그대로 붙여넣기 → Deploy
//   2) 키 넣기: 앱에서 admin 으로 ⚙ 설정 → "서버 공용 키" 에 입력  (또는 이 함수 Secret 에)
//   3) app/config.js 의 AI_PROXY 를 true 로 (또는 주소에 ?ai=1)
//
//  호출은 로그인(익명 포함)한 사용자만 가능하다 — Supabase 게이트웨이가 JWT 를 검사한다.
//  요청  { images: ["data:image/...;base64,..."], context?: string, model?: string }
//  응답  { summary, observed: string[], hazards: string[], provider, model }
//        또는 { error: { message, status, quota?, daily?, retryAfterSec? } }
// ============================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROMPT =
  "당신은 건설장비(굴착기) 정비 접수를 돕는 분석가입니다. 첨부된 현장 사진을 보고 " +
  "반드시 아래 키를 가진 JSON 객체만 출력하세요(다른 텍스트 금지):\n" +
  '{"summary":"현상 한 줄 요약(한국어)","observed":["보이는 장비/부품(한국어)"],' +
  '"hazards":["화재·연기·누유 등 위험 신호(없으면 빈 배열)"]}';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

/** "data:image/jpeg;base64,XXXX" → { mime, data } */
function parseDataURI(uri: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(uri || "");
  return m ? { mime: m[1], data: m[2] } : null;
}

/** 모델 응답 텍스트에서 JSON 만 뽑아 구조화 */
function parseFindings(text: string) {
  const t = String(text || "");
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const o = JSON.parse(t.slice(s, e + 1));
    return {
      summary: String(o.summary || ""),
      observed: Array.isArray(o.observed) ? o.observed.map(String) : [],
      hazards: Array.isArray(o.hazards) ? o.hazards.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** DB(ai_config) 에서 키·모델을 읽는다. 없으면 null → 호출부가 Secret 으로 폴백. */
async function configFromDB(): Promise<{ key: string; model: string | null } | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) return null;
  try {
    const r = await fetch(`${url}/rest/v1/ai_config?id=eq.1&select=api_key,model`, {
      headers: { apikey: svc, authorization: `Bearer ${svc}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row?.api_key && String(row.api_key).trim()) {
      return { key: String(row.api_key).trim(), model: row.model ? String(row.model).trim() : null };
    }
  } catch {
    /* 폴백 */
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: { message: "POST 만 허용", status: 405 } }, 405);

  const fromDB = await configFromDB();
  const key = fromDB?.key || Deno.env.get("GEMINI_API_KEY");
  if (!key) {
    return json({ error: { message: "AI 키가 없습니다. 관리자가 ⚙ 설정에서 서버 공용 키를 넣어 주세요.", status: 500 } }, 200);
  }
  const model = fromDB?.model || Deno.env.get("GEMINI_MODEL") || "gemini-3.6-flash";

  let payload: { images?: string[]; context?: string; model?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: { message: "요청 본문을 읽지 못했습니다.", status: 400 } }, 400);
  }

  const images = (payload.images || []).slice(0, 3);
  if (!images.length) return json({ error: { message: "이미지가 없습니다.", status: 400 } }, 400);

  const useModel = payload.model || model;
  const parts: unknown[] = [
    { text: PROMPT + (payload.context ? "\n\n접수자 설명: " + payload.context : "") },
  ];
  for (const uri of images) {
    const p = parseDataURI(uri);
    if (p) parts.push({ inline_data: { mime_type: p.mime, data: p.data } });
  }

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(useModel) +
    ":generateContent";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    });
  } catch (e) {
    return json({ error: { message: "Gemini 호출 실패: " + String(e), status: 502 } }, 502);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status === 429) {
      // RetryInfo.retryDelay 가 있으면 분당 한도(잠깐), 없으면 일일 소진
      let retry: number | null = null;
      const details = body?.error?.details || [];
      for (const d of details) {
        if (/RetryInfo/.test(d["@type"] || "") && d.retryDelay) {
          retry = Math.ceil(parseFloat(String(d.retryDelay).replace(/[^0-9.]/g, "")) || 0);
        }
      }
      return json(
        { error: { message: "Gemini 무료 한도 초과", status: 429, quota: true, daily: retry == null, retryAfterSec: retry } },
        200, // 앱이 error 객체를 그대로 읽어 안내하도록 200 으로 내려 준다
      );
    }
    return json({ error: { message: "Gemini 오류 (HTTP " + res.status + ")", status: res.status } }, 200);
  }

  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const findings = parseFindings(text);
  if (!findings) return json({ error: { message: "응답을 해석하지 못했습니다.", status: 502 } }, 200);

  return json({ ...findings, provider: "gemini(server)", model: useModel, image_count: images.length });
});
