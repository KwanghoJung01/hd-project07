/* 자동 생성 파일 — 직접 수정 금지. `node tools/build-schema-bundle.js` 로 재생성 */
(function (root) {
  root.FI_SCHEMA = {
  "domains": {
    "version": "1.0.0",
    "description": "Field-Insight Domain 분류 정의. MVP-1에서는 정비(maintenance)만 active이며, 나머지 도메인은 구조(코드/라벨/키워드 슬롯)만 정의한다. Domain 추가 시 이 파일에 항목을 추가하고 schema_ref로 Requirement Schema 파일을 연결한다.",
    "safety_keywords": [
      "화재",
      "불이 붙",
      "불이 났",
      "불꽃",
      "연기",
      "타는 냄새",
      "타는냄새",
      "브레이크가 안",
      "브레이크 안",
      "제동이 안",
      "제동 안",
      "멈추지 않",
      "전복",
      "넘어질 것",
      "쓰러질 것",
      "감전",
      "폭발",
      "연료가 새",
      "연료가 뿜",
      "기름이 뿜"
    ],
    "safety_notice": "안전 위험 키워드 감지 시(FR-05) 정보수집을 중단하고 긴급 경고 및 에스컬레이션 안내로 즉시 분기한다.",
    "domains": [
      {
        "code": "maintenance",
        "label": "정비",
        "active": true,
        "mvp": 1,
        "schema_ref": "schema/maintenance.requirements.json",
        "keywords": [
          "덜컹",
          "소음",
          "이상음",
          "진동",
          "떨림",
          "충격",
          "흔들",
          "누유",
          "오일이 새",
          "기름이 새",
          "경고등",
          "알람",
          "고장",
          "수리",
          "정비",
          "점검",
          "시동이 안",
          "시동 불량",
          "엔진",
          "유압",
          "작동이 안",
          "움직이지 않",
          "멈춥",
          "꺼져",
          "꺼집",
          "느려",
          "속도가 안",
          "힘이 없",
          "출력이 떨어"
        ],
        "intents": [
          {
            "code": "abnormal_symptom",
            "label": "이상 현상 진단"
          },
          {
            "code": "warning_lamp",
            "label": "경고등·알람 문의"
          }
        ]
      },
      {
        "code": "operation",
        "label": "운전",
        "active": false,
        "mvp": 5,
        "schema_ref": null,
        "keywords": [
          "조작 방법",
          "조작이 어려",
          "레버",
          "운전 방법",
          "작업 요령",
          "평탄 작업",
          "조종"
        ],
        "intents": []
      },
      {
        "code": "education",
        "label": "교육",
        "active": false,
        "mvp": 5,
        "schema_ref": null,
        "keywords": [
          "교육",
          "신입",
          "배우고",
          "교육생",
          "훈련",
          "가르치",
          "실습"
        ],
        "intents": []
      },
      {
        "code": "quality",
        "label": "품질",
        "active": false,
        "mvp": 5,
        "schema_ref": null,
        "keywords": [
          "불량",
          "도장",
          "조립 상태",
          "납품",
          "품질",
          "마감"
        ],
        "intents": []
      },
      {
        "code": "safety",
        "label": "안전",
        "active": false,
        "mvp": 5,
        "schema_ref": null,
        "keywords": [
          "안전 수칙",
          "보호구",
          "위험해 보",
          "안전 점검"
        ],
        "intents": []
      },
      {
        "code": "tech_inquiry",
        "label": "기술문의",
        "active": false,
        "mvp": 5,
        "schema_ref": null,
        "keywords": [
          "사양",
          "스펙",
          "규격",
          "호환",
          "제원",
          "몇 톤",
          "용량",
          "토크"
        ],
        "intents": []
      },
      {
        "code": "usability",
        "label": "사용성",
        "active": false,
        "mvp": 5,
        "schema_ref": null,
        "keywords": [
          "화면 사용",
          "버튼이 어디",
          "메뉴",
          "설정 방법",
          "모니터 사용"
        ],
        "intents": []
      },
      {
        "code": "etc",
        "label": "기타",
        "active": false,
        "mvp": 5,
        "schema_ref": null,
        "keywords": [],
        "intents": []
      }
    ]
  },
  "maintenance": {
    "version": "1.0.0",
    "domain": "maintenance",
    "domain_label": "정비",
    "description": "정비 Domain Requirement / Question Matrix (기획서 원문 7.2 MNT-01~12 그대로). 판별력(discriminative_weight)은 확정 시 배제 가능한 원인 후보 수이며 LLM 추론이 아니라 사전 정의 정수 가중치다. DecisionImpact = 판별력 × 획득가능성 계수 × 미확보도.",
    "obtainability_factors": {
      "상": 1,
      "중": 0.6,
      "하": 0.1,
      "자동": 0
    },
    "uncovered_factors": {
      "uncovered": 1,
      "partial": 0.5,
      "covered": 0
    },
    "question_budget": 3,
    "confirm_threshold": 0.7,
    "confirm_max": 2,
    "requirements": [
      {
        "requirement_id": "MNT-01",
        "label": "발생 현상",
        "discriminative_weight": 5,
        "obtainability": "상",
        "ask_policy": "ask",
        "answer_type": "free_choice",
        "question_text": "어떤 현상이 나타났나요?",
        "options": [
          "충격",
          "소음",
          "속도저하",
          "누유",
          "경고등"
        ],
        "priority": 1,
        "validation_rule": null,
        "extract": [
          {
            "any": [
              "덜컹",
              "충격",
              "쿵",
              "흔들"
            ],
            "value": "충격"
          },
          {
            "any": [
              "소음",
              "이상음",
              "소리가 나",
              "삐걱"
            ],
            "value": "소음"
          },
          {
            "any": [
              "느려",
              "속도가 안",
              "힘이 없",
              "출력이 떨어"
            ],
            "value": "속도저하"
          },
          {
            "any": [
              "누유",
              "오일이 새",
              "기름이 새"
            ],
            "value": "누유"
          },
          {
            "any": [
              "경고등",
              "알람"
            ],
            "value": "경고등"
          }
        ]
      },
      {
        "requirement_id": "MNT-02",
        "label": "발생 작업",
        "discriminative_weight": 4,
        "obtainability": "상",
        "ask_policy": "ask",
        "answer_type": "choice",
        "question_text": "어떤 작업 중에 발생했나요?",
        "options": [
          "굴착",
          "선회",
          "주행",
          "적재",
          "공회전"
        ],
        "priority": 2,
        "validation_rule": null,
        "extract": [
          {
            "any": [
              "굴착",
              "땅을 파",
              "파는 중"
            ],
            "value": "굴착"
          },
          {
            "any": [
              "선회",
              "돌면",
              "돌 때",
              "회전할 때",
              "회전하면"
            ],
            "value": "선회"
          },
          {
            "any": [
              "주행",
              "달릴 때",
              "이동 중"
            ],
            "value": "주행"
          },
          {
            "any": [
              "적재",
              "싣는",
              "실을 때"
            ],
            "value": "적재"
          },
          {
            "any": [
              "공회전",
              "아이들"
            ],
            "value": "공회전"
          }
        ]
      },
      {
        "requirement_id": "MNT-03",
        "label": "발생 조건(동작 조합)",
        "discriminative_weight": 5,
        "obtainability": "상",
        "ask_policy": "ask",
        "answer_type": "choice",
        "question_text": "어떤 동작 조합에서 발생하나요?",
        "options": [
          "붐 하강 시",
          "붐 상승 시",
          "무관",
          "모르겠음"
        ],
        "priority": 3,
        "validation_rule": null,
        "extract": [
          {
            "any": [
              "붐을 내리",
              "붐 내리",
              "붐 하강"
            ],
            "all": [
              "돌"
            ],
            "value": "붐 하강 + 우선회"
          },
          {
            "any": [
              "붐을 내리",
              "붐 내리",
              "붐 하강"
            ],
            "value": "붐 하강 시"
          },
          {
            "any": [
              "붐을 올리",
              "붐 올리",
              "붐 상승"
            ],
            "value": "붐 상승 시"
          }
        ]
      },
      {
        "requirement_id": "MNT-04",
        "label": "재현성",
        "discriminative_weight": 5,
        "obtainability": "상",
        "ask_policy": "ask",
        "answer_type": "choice",
        "question_text": "이 현상은 언제 발생하나요?",
        "options": [
          "항상",
          "특정 조건에서만",
          "가끔",
          "모르겠음"
        ],
        "priority": 4,
        "validation_rule": null,
        "extract": [
          {
            "any": [
              "항상 그래",
              "항상 발생",
              "매번 그래"
            ],
            "value": "항상"
          },
          {
            "any": [
              "특정 조건"
            ],
            "value": "특정 조건에서만"
          }
        ]
      },
      {
        "requirement_id": "MNT-05",
        "label": "예열 상태(냉간/온간)",
        "discriminative_weight": 5,
        "obtainability": "상",
        "ask_policy": "ask",
        "answer_type": "choice",
        "question_text": "시동 직후에도 발생하나요?",
        "options": [
          "시동 직후",
          "데워진 후",
          "무관",
          "모르겠음"
        ],
        "priority": 5,
        "validation_rule": null,
        "extract": [
          {
            "any": [
              "시동 직후",
              "시동 걸자마자",
              "냉간"
            ],
            "value": "시동 직후"
          },
          {
            "any": [
              "데워진 후",
              "예열 후에도",
              "온간"
            ],
            "value": "데워진 후"
          }
        ]
      },
      {
        "requirement_id": "MNT-06",
        "label": "발생 빈도",
        "discriminative_weight": 3,
        "obtainability": "상",
        "ask_policy": "ask",
        "answer_type": "choice",
        "question_text": "얼마나 자주 발생하나요?",
        "options": [
          "매번",
          "하루 수회",
          "주 1회 이하"
        ],
        "priority": 6,
        "validation_rule": null,
        "extract": [
          {
            "any": [
              "매번"
            ],
            "value": "매번"
          },
          {
            "any": [
              "하루에 몇 번",
              "하루 수회"
            ],
            "value": "하루 수회"
          },
          {
            "any": [
              "일주일에 한",
              "주 1회"
            ],
            "value": "주 1회 이하"
          },
          {
            "any": [
              "가끔",
              "간헐"
            ],
            "value": "가끔 발생",
            "coverage": "partial",
            "source": "inferred"
          }
        ]
      },
      {
        "requirement_id": "MNT-07",
        "label": "엔진 RPM 변화",
        "discriminative_weight": 4,
        "obtainability": "중",
        "ask_policy": "ask",
        "answer_type": "choice",
        "question_text": "현상 발생 시 엔진 소리(RPM)에 변화가 있나요?",
        "options": [
          "동일",
          "낮아짐",
          "높아짐",
          "모르겠음"
        ],
        "priority": 8,
        "validation_rule": null,
        "extract": [
          {
            "any": [
              "알피엠이 떨어",
              "rpm이 떨어",
              "엔진이 죽",
              "엔진 소리가 낮아"
            ],
            "value": "낮아짐"
          },
          {
            "any": [
              "rpm이 올라",
              "엔진 소리가 높아"
            ],
            "value": "높아짐"
          }
        ]
      },
      {
        "requirement_id": "MNT-08",
        "label": "최근 정비 이력",
        "discriminative_weight": 4,
        "obtainability": "중",
        "ask_policy": "ask",
        "answer_type": "choice",
        "question_text": "최근 1개월 내 정비 이력이 있나요?",
        "options": [
          "있음(1개월 내)",
          "없음",
          "모르겠음"
        ],
        "priority": 7,
        "validation_rule": null,
        "extract": [
          {
            "any": [
              "정비를 받",
              "수리를 받",
              "정비했",
              "수리했",
              "부품을 교체"
            ],
            "value": "있음(1개월 내)",
            "source": "inferred",
            "coverage": "partial"
          }
        ]
      },
      {
        "requirement_id": "MNT-09",
        "label": "경고등/알람",
        "discriminative_weight": 4,
        "obtainability": "상",
        "ask_policy": "ask",
        "answer_type": "choice",
        "question_text": "경고등이나 알람이 표시되나요?",
        "options": [
          "없음",
          "있음(촬영)",
          "모르겠음"
        ],
        "priority": 9,
        "validation_rule": null,
        "extract": [
          {
            "any": [
              "경고등이 켜",
              "경고등 점등",
              "알람이 울",
              "램프가 켜"
            ],
            "value": "있음(촬영)"
          },
          {
            "any": [
              "경고등은 없",
              "경고등 없",
              "알람은 없"
            ],
            "value": "없음"
          }
        ]
      },
      {
        "requirement_id": "MNT-10",
        "label": "유압 온도",
        "discriminative_weight": 3,
        "obtainability": "하",
        "ask_policy": "expert_check",
        "answer_type": "measure",
        "question_text": null,
        "options": [],
        "priority": 10,
        "validation_rule": null,
        "extract": [],
        "note": "질문하지 않음. 계측 필요 항목 → '정보 부족' 표기 후 전문가 추가 확인 항목으로 넘긴다."
      },
      {
        "requirement_id": "MNT-11",
        "label": "선회 압력",
        "discriminative_weight": 4,
        "obtainability": "하",
        "ask_policy": "expert_check",
        "answer_type": "measure",
        "question_text": null,
        "options": [],
        "priority": 11,
        "validation_rule": null,
        "extract": [],
        "note": "질문하지 않음. 계측 필요 항목 → '정보 부족' 표기 후 전문가 추가 확인 항목으로 넘긴다."
      },
      {
        "requirement_id": "MNT-12",
        "label": "장비 식별(모델/SN/가동시간)",
        "discriminative_weight": 5,
        "obtainability": "자동",
        "ask_policy": "auto_acquire",
        "answer_type": "system",
        "question_text": null,
        "options": [
          "QR",
          "시리얼",
          "보유장비 선택"
        ],
        "priority": 0,
        "validation_rule": null,
        "extract": [],
        "note": "질문 예산을 소모하지 않는다. QR/시리얼/보유장비 선택 UI로 시스템이 자동 획득한다(P5)."
      }
    ],
    "scenarios": [
      {
        "scenario_id": "MNT-S01",
        "label": "이상 현상(이음·충격·거동 이상)",
        "default": true,
        "trigger_keywords": [],
        "requirement_ids": [
          "MNT-01",
          "MNT-02",
          "MNT-03",
          "MNT-04",
          "MNT-05",
          "MNT-06",
          "MNT-07",
          "MNT-08",
          "MNT-10",
          "MNT-11",
          "MNT-12"
        ],
        "note": "원문 15장 Step 2의 정보요건 집합(현상·조건·작업·재현성·예열·빈도·RPM·정비이력 + 계측 2종 + 장비 식별)."
      },
      {
        "scenario_id": "MNT-S02",
        "label": "경고등·알람 점등",
        "default": false,
        "trigger_keywords": [
          "경고등",
          "알람",
          "램프가 켜"
        ],
        "requirement_ids": [
          "MNT-01",
          "MNT-02",
          "MNT-05",
          "MNT-06",
          "MNT-08",
          "MNT-09",
          "MNT-12"
        ],
        "note": "질문 유형에 따라 질문 Tree(정보요건 집합) 자체가 달라진다는 Dynamic Requirement Identification 예시."
      }
    ]
  },
  "parts": {
    "version": "1.0.0",
    "description": "굴착기 부품/계통 코드 마스터 샘플. 전문가 결론(확정원인)의 계통/부품은 자유 텍스트 금지 — 반드시 이 마스터에서 검색·선택한다. 코드가 없으면 집계와 학습이 불가능하다(원문 10.3).",
    "systems": [
      {
        "system_code": "SW-HYD",
        "label": "선회 유압 계통",
        "group": "선회"
      },
      {
        "system_code": "SW-MEC",
        "label": "선회 기계 계통",
        "group": "선회"
      },
      {
        "system_code": "HYD-MN",
        "label": "메인 유압 계통",
        "group": "유압"
      },
      {
        "system_code": "HYD-AT",
        "label": "작업장치 유압 계통",
        "group": "유압"
      },
      {
        "system_code": "TR-DRV",
        "label": "주행 구동 계통",
        "group": "주행"
      },
      {
        "system_code": "TR-UND",
        "label": "하부주행체 계통",
        "group": "주행"
      },
      {
        "system_code": "EN-CR",
        "label": "엔진 본체 계통",
        "group": "엔진"
      },
      {
        "system_code": "EN-AUX",
        "label": "엔진 보조 계통",
        "group": "엔진"
      },
      {
        "system_code": "EL-PW",
        "label": "전장 전원 계통",
        "group": "전장"
      },
      {
        "system_code": "EL-CT",
        "label": "전장 제어 계통",
        "group": "전장"
      }
    ],
    "parts": [
      {
        "part_code": "SW-HYD-0412",
        "label": "선회 모터 릴리프 밸브",
        "system_code": "SW-HYD"
      },
      {
        "part_code": "SW-HYD-0201",
        "label": "선회 모터",
        "system_code": "SW-HYD"
      },
      {
        "part_code": "SW-HYD-0305",
        "label": "선회 브레이크 밸브",
        "system_code": "SW-HYD"
      },
      {
        "part_code": "SW-MEC-0105",
        "label": "선회 감속기",
        "system_code": "SW-MEC"
      },
      {
        "part_code": "SW-MEC-0310",
        "label": "스윙 서클 베어링",
        "system_code": "SW-MEC"
      },
      {
        "part_code": "HYD-MN-0101",
        "label": "메인 유압 펌프",
        "system_code": "HYD-MN"
      },
      {
        "part_code": "HYD-MN-0205",
        "label": "메인 컨트롤 밸브",
        "system_code": "HYD-MN"
      },
      {
        "part_code": "HYD-MN-0401",
        "label": "유압 오일 필터",
        "system_code": "HYD-MN"
      },
      {
        "part_code": "HYD-MN-0502",
        "label": "파일럿 펌프",
        "system_code": "HYD-MN"
      },
      {
        "part_code": "HYD-AT-0301",
        "label": "붐 실린더",
        "system_code": "HYD-AT"
      },
      {
        "part_code": "HYD-AT-0302",
        "label": "암 실린더",
        "system_code": "HYD-AT"
      },
      {
        "part_code": "HYD-AT-0303",
        "label": "버킷 실린더",
        "system_code": "HYD-AT"
      },
      {
        "part_code": "TR-DRV-0101",
        "label": "주행 모터",
        "system_code": "TR-DRV"
      },
      {
        "part_code": "TR-DRV-0202",
        "label": "주행 감속기",
        "system_code": "TR-DRV"
      },
      {
        "part_code": "TR-UND-0301",
        "label": "트랙 링크",
        "system_code": "TR-UND"
      },
      {
        "part_code": "TR-UND-0305",
        "label": "아이들러",
        "system_code": "TR-UND"
      },
      {
        "part_code": "EN-CR-0101",
        "label": "연료 분사 펌프",
        "system_code": "EN-CR"
      },
      {
        "part_code": "EN-CR-0401",
        "label": "터보차저",
        "system_code": "EN-CR"
      },
      {
        "part_code": "EN-AUX-0201",
        "label": "라디에이터(냉각 계통)",
        "system_code": "EN-AUX"
      },
      {
        "part_code": "EN-AUX-0301",
        "label": "에어클리너",
        "system_code": "EN-AUX"
      },
      {
        "part_code": "EL-PW-0101",
        "label": "배터리",
        "system_code": "EL-PW"
      },
      {
        "part_code": "EL-PW-0402",
        "label": "경고등 회로",
        "system_code": "EL-PW"
      },
      {
        "part_code": "EL-CT-0205",
        "label": "압력 센서",
        "system_code": "EL-CT"
      },
      {
        "part_code": "EL-CT-0301",
        "label": "메인 컨트롤러(ECU)",
        "system_code": "EL-CT"
      }
    ]
  },
  "undetermined": {
    "version": "1.0.0",
    "description": "'원인 미확정' 종결 시 필수로 선택해야 하는 사유 코드(원문 10.3). 강제 확정은 데이터를 오염시키므로 미확정 종결을 허용하되 사유 코드는 필수다.",
    "reasons": [
      {
        "code": "UND-INFO",
        "label": "정보부족"
      },
      {
        "code": "UND-REPRO",
        "label": "재현불가"
      },
      {
        "code": "UND-NOREPLY",
        "label": "고객 미회신"
      },
      {
        "code": "UND-TRANSFER",
        "label": "타 부서 이관"
      }
    ]
  }
};
})(typeof self !== "undefined" ? self : this);
