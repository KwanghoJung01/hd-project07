#!/usr/bin/env node
/**
 * schema/*.json → app/schema.bundle.js 생성기
 *
 * index.html을 file:// 로 직접 열어도 스키마를 읽을 수 있도록
 * (브라우저 fetch는 file:// 에서 차단됨) JSON 원본을 전역 변수로 번들한다.
 * 스키마 JSON 원본이 항상 단일 진실(SSOT)이며, 이 스크립트로만 번들을 갱신한다.
 * 번들과 원본의 일치 여부는 tests/unit.test.js가 검증한다.
 *
 * 사용법: node tools/build-schema-bundle.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const bundle = {
  domains: read("schema/domains.json"),
  maintenance: read("schema/maintenance.requirements.json"),
  parts: read("schema/parts.master.json"),
  undetermined: read("schema/undetermined_reasons.json")
};

const out =
  "/* 자동 생성 파일 — 직접 수정 금지. `node tools/build-schema-bundle.js` 로 재생성 */\n" +
  "(function (root) {\n" +
  "  root.FI_SCHEMA = " + JSON.stringify(bundle, null, 2) + ";\n" +
  "})(typeof self !== \"undefined\" ? self : this);\n";

fs.writeFileSync(path.join(root, "app/schema.bundle.js"), out, "utf8");
console.log("app/schema.bundle.js 생성 완료");
