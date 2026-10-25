# ScorePlus

ScorePlus gồm frontend luyện tập và dịch vụ gia sư AI trong cùng một thư mục dự án. AI-Portal là repo độc lập bên cạnh ScorePlus.

```text
ScorePlus/
├── frontend/       # Next.js static app, đóng gói để cài vào AI-Portal
└── ai-service/     # Gia sư AI: API, model, dữ liệu, huấn luyện và đánh giá
```

## Frontend

Đọc [hướng dẫn frontend](frontend/README.md). Chạy local hoặc đóng gói từ thư mục frontend:

```bash
cd ScorePlus/frontend
npm install
npm run dev
```

## AI service

API gia sư gợi ý từng bước (vLLM `qwen3.5-35b-a3b-int4`): `cd ScorePlus/ai-service && npm start`. Xem [ai-service/README.md](ai-service/README.md).
