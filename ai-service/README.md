# ScorePlus AI Service

Dịch vụ gia sư AI của ScorePlus, đặt ngang cấp với `frontend/`. Service nhận trạng thái làm bài từ frontend, chọn cấp gợi ý, tự dựng prompt và gọi LLM qua Kong: mặc định vLLM (`qwen3.5-35b-a3b-int4`, API chuẩn OpenAI), có thể chuyển sang Ollama. Khóa `x-ollama-seckey` chỉ nằm ở server; frontend tĩnh không giữ khóa và không gửi prompt tùy ý.

```text
Frontend ScorePlus ──POST /v1/hint──▶ ai-service ──POST /v1/chat/completions + x-ollama-seckey──▶ Kong/vLLM
```

## Chạy

Yêu cầu Node.js >= 20.12, không cần `npm install` (chỉ dùng thư viện chuẩn).

```bash
cd ScorePlus/ai-service
test -f .env || cp .env.example .env   # rồi điền LLM_API_KEY
npm start                              # http://localhost:8090
npm test
```

Frontend đặt `NEXT_PUBLIC_SCOREPLUS_AI_URL=http://localhost:8090` trong `frontend/.env.local` rồi chạy lại `npm run dev`.

## Cấu hình (`.env`)

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PORT` | `8090` | Cổng HTTP |
| `LLM_PROVIDER` | `vllm` | `vllm` (OpenAI-compatible) hoặc `ollama` (`/api/chat`) |
| `LLM_BASE_URL` | `http://101.96.66.232:8037/vllm` | Gốc API LLM (qua Kong) |
| `LLM_API_KEY` | — | Giá trị header `x-ollama-seckey` |
| `LLM_MODEL` | `qwen3.5-35b-a3b-int4` | Model chat (xem `GET <base>/v1/models`) |
| `LLM_TIMEOUT_MS` | `60000` | Thời gian chờ model |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000` | Origin frontend được phép, phân tách bằng dấu phẩy |
| `RATE_LIMIT_PER_MINUTE` | `20` | Số yêu cầu gợi ý mỗi IP mỗi phút |
| `HINT_LEVEL2_ATTEMPTS` / `HINT_LEVEL3_ATTEMPTS` | `2` / `3` | Số lần sai để lên cấp 2 / cấp 3 |
| `HINT_REQUIRE_SOLUTION` | `true` | Câu thiếu lời giải đã xác minh → báo chưa đủ căn cứ |
| `HINT_ALLOW_ANSWER_AT_LEVEL3` | `false` | Cấp 3 được nêu đáp án đúng |
| `HINT_LOG_DIR` | `logs/` | Thư mục log; đặt rỗng để tắt |

## Cơ chế gợi ý (giai đoạn 1 của đề cương)

Mỗi request đi qua bốn bước:

1. **Chọn cấp** – [models/policy.mjs](models/policy.mjs), rule-based theo bảng trạng thái:

   | Trạng thái | Điều kiện | Hỗ trợ |
   | --- | --- | --- |
   | `no_answer` | chưa chọn đáp án | cấp 1, mỗi lần xin thêm +1 cấp |
   | `answered_hidden` | đã chọn nhưng chưa biết đúng/sai (chưa nộp) | cấp 1–2, không để lộ đúng/sai |
   | `wrong_first` | sai, số lần thử = 1 | cấp 1 |
   | `wrong_repeated` | sai, số lần thử ≥ `HINT_LEVEL2_ATTEMPTS` / `HINT_LEVEL3_ATTEMPTS` | cấp 2 / cấp 3 |
   | `correct` | đã chọn đúng và được công bố | củng cố ngắn |
   | `missing_data` | thiếu đáp án chuẩn hoặc lời giải đã xác minh | báo chưa đủ căn cứ, không gọi LLM |

   Xin thêm gợi ý khi chưa chọn lại đáp án tăng một cấp, tối đa cấp 3 (vd. sai 2 lần → cấp 2; xin thêm ngay sau đó → cấp 3). Cấp 1 – Gợi nhớ, cấp 2 – Định hướng, cấp 3 – Giải thích.
2. **Dựng prompt** – [app/hint.mjs](app/hint.mjs): quy tắc chung, quy tắc theo trạng thái/cấp, đáp án chuẩn và lời giải tham khảo (đánh dấu không được tiết lộ). Ở `answered_hidden`, lựa chọn của sinh viên không được đưa vào prompt để model không thể để lộ đúng/sai. Gọi model với `temperature 0.2`, tắt chế độ suy luận (`enable_thinking: false`); thời gian phản hồi thực tế khoảng 1,5–3,5 giây.
3. **Kiểm tra đầu ra** – [app/guard.mjs](app/guard.mjs): không lộ chữ cái/nội dung đáp án đúng khi chưa được phép, không có số liệu ngoài câu hỏi/lời giải, không quá dài. Vi phạm thì yêu cầu LLM viết lại một lần; vẫn vi phạm thì trả thông báo thay vì nội dung đó.
4. **Ghi log** – [app/log.mjs](app/log.mjs): JSONL theo ngày trong `logs/` (đã gitignore) gồm học phần, câu hỏi, trạng thái, cấp, số lần thử, kết quả kiểm tra, độ trễ và nội dung gợi ý (cả bản bị chặn). Không ghi thông tin tài khoản. Dùng cho giai đoạn 2 (phân tích gợi ý kém) và đánh giá RQ1.

## API

`GET /health` → `{ "status": "ok", "model": "..." }`

`POST /v1/hint`

```json
{
  "subject_id": "kt-vi-mo", "subject_name": "Kinh tế vi mô", "chapter": "Chương 2", "question_id": "q1",
  "question": "Khi giá cà phê tăng, cầu về đường (hàng bổ sung) thay đổi thế nào?",
  "context": "", "code": "",
  "options": [{ "key": "A", "text": "Cầu về đường tăng" }, { "key": "B", "text": "Cầu về đường giảm" }],
  "selected": "A", "correct": "B", "revealed": true, "attempts": 1, "hint_count": 1,
  "explanation": "Cà phê và đường là hàng bổ sung: ..."
}
```

`revealed`: sinh viên đã được biết lựa chọn đúng/sai chưa. `answer_shown`: đáp án đúng đã hiện trên giao diện (hết lượt thử) — khi đó cấp 3 được nêu đáp án. `attempts`: số lần đã chọn đáp án ở câu này. `hint_count`: lần xin gợi ý thứ mấy kể từ lần chọn đáp án gần nhất (≥ 1); frontend đếm lại từ 1 mỗi khi sinh viên chọn lại, vì cấp đã tăng theo số lần sai.

Trả về `{ "status": "ok" | "insufficient" | "blocked", "content": "<Markdown>", "state": "...", "level": 0-3, "label": "Gợi nhớ", "model": "..." }`. Lỗi trả `{ "message": "..." }` với mã 400 (dữ liệu sai), 403 (origin không được phép), 429 (quá nhiều yêu cầu), 502/504 (lỗi hoặc quá thời gian từ Ollama). Lỗi chi tiết từ Ollama chỉ ghi log ở server.

## Triển khai

- **Trong AI-Portal (mặc định):** `npm run pack` ở `frontend/` gộp service này vào cùng gói ZIP ([portal/embed.js](portal/embed.js) → `dist/embed.js`). Portal chạy nó trong process backend tại `/api/apps/scoreplus`, cùng origin với trang nên không cần CORS hay URL HTTPS riêng; rate limit tính theo tài khoản Portal (khách: theo IP). Cấu hình đọc từ `.env` trong gói (tạo từ `ai-service/.env.portal`) và biến `SCOREPLUS_<TÊN>` của server Portal; xem [frontend/README.md](../frontend/README.md).
- **Chạy riêng:** cần URL HTTPS (reverse proxy) vì Portal chạy HTTPS, thêm origin Portal vào `CORS_ALLOWED_ORIGINS`. Khi chạy sau reverse proxy, rate limit dựa trên `X-Forwarded-For`.
- Kong chặn preflight CORS khi thiếu khóa, vì vậy trình duyệt không thể gọi LLM trực tiếp; luôn đi qua service này.

## Giới hạn đã biết

- Ở cấp 3 (khi chưa cho phép nêu đáp án), model đôi khi diễn đạt lại kết luận đúng bằng lời khác; bộ kiểm tra chỉ bắt chữ cái và nguyên văn phương án, không bắt được diễn đạt lại.
- Kiểm tra số liệu chỉ so khớp số xuất hiện trong câu hỏi/lời giải, chưa kiểm tra tính đúng của phép tính.

## Hướng phát triển

- `models/`: thêm mô hình phân loại loại lỗi (giai đoạn 3) để so sánh với chính sách rule-based.
- `data/`: dữ liệu được phép sử dụng, nhãn lỗi và cấu hình môn học. Không đưa dữ liệu cá nhân/nhạy cảm vào Git.
- `training/`, `evaluation/`: huấn luyện khi đã có tập nhãn và bộ đánh giá chất lượng gợi ý. Gia sư không thay thế đáp án chuẩn hoặc việc chấm điểm của ScoreUp.
