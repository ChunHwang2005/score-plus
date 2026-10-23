# ScorePlus

Ứng dụng Next.js frontend-only cho AI Portal, dựa trên luồng **Luyện tập sinh viên** của ScoreUp. Không có navbar; không cần backend hoặc database riêng.

## Chạy local

Yêu cầu Node.js >= 20.9 và npm.

```bash
cd ScorePlus/frontend
npm install
# Chỉ tạo .env.local nếu chưa có (không ghi đè cấu hình hiện tại):
test -f .env.local || cp .env.example .env.local
npm run dev
```

Mở http://localhost:3010/ . Chế độ dev chạy ở đường dẫn gốc; link cũ `/embed/scoreplus/` sẽ chuyển về `/`. Khi build/pack, ứng dụng vẫn dùng `/embed/scoreplus/` cho AI Portal. Sau khi thay đổi `next.config.mjs`, hãy dừng và chạy lại `npm run dev`.

`.env.example` mặc định gọi BE local tại `http://localhost:3006/v1/api`. Nếu dùng server ScoreUp có sẵn, chỉnh `.env.local` theo mục bên dưới. Không copy đè `.env.local` đã cấu hình. API danh sách môn trên server đã được kiểm tra trả HTTP 200, nhưng preflight từ `http://localhost:3010` chưa có `Access-Control-Allow-Origin`: quản trị BE cần thêm origin local/Portal vào CORS trước khi trình duyệt gọi được.

## Kết nối ScoreUp

Chỉnh `.env.local` trước khi build:

```dotenv
NEXT_PUBLIC_SCOREUP_API_URL=https://fit.neu.edu.vn/scoreup/v1/api
NEXT_PUBLIC_SCOREUP_MEDIA_URL=https://fit.neu.edu.vn/scoreup/media/
PORTAL_BASE_PATH=
```

URL trên là ví dụ theo cấu hình ScoreUp trong workspace; cần xác nhận URL media thực tế của môi trường triển khai. Các biến `NEXT_PUBLIC_*` là công khai, được nhúng lúc build; thay đổi URL cần build và upload lại. Không đặt mật khẩu, token hoặc secret vào các biến này.

BE ScoreUp phải cho phép origin của Portal (và `http://localhost:3010` khi dev) trong `CORS_ALLOWED_ORIGINS`, ví dụ `https://portal.example.com,http://localhost:3010`. Origin không chứa path. Request dùng Bearer, không dùng cookie xuyên domain. Khi Portal chạy HTTPS, API và media cũng cần HTTPS.

Các API được sử dụng (đã đối chiếu source ScoreUp):

| API | Chức năng |
| --- | --- |
| `GET /user/info` | Kiểm tra token và lấy người dùng |
| `GET /subjects/?visible_for_practice_only=1` | Môn học và danh sách chương |
| `POST /questions` | Lấy câu hỏi với `subject_id`, `chapter_id`, `limit` |
| `POST /questions/result` | Lưu kết quả, BE lấy user từ Bearer token |

Ứng dụng nhận tài khoản AI-Portal từ `window.__PORTAL_USER__` hoặc postMessage `{ type: 'PORTAL_USER', user: { id, email, name } }`, đồng thời gửi `PORTAL_APP_NEED_USER` khi mở iframe và gọi `GET /api/auth/session` với cookie cùng origin để lấy tài khoản trực tiếp. Trên `ai.neu.edu.vn/apps`, URL được tự ghép thành `https://ai.neu.edu.vn/apps/api/auth/session`. Frontend chỉ giữ `{ id, email, name }`, bỏ `accessToken`, `profile`, `image` và `is_admin`. Endpoint session trả thông tin đăng nhập Portal, không cấp token ScoreUp; không đặt `/api/auth/session` vào biến `NEXT_PUBLIC_PORTAL_SCOREUP_SESSION_PATH`. Chỉ nhận message từ parent cùng origin. Không có nút/form đăng nhập hoặc đăng xuất riêng; tài khoản được quản lý ở Portal.

User context của Portal không phải token ScoreUp. Để làm bài/lưu kết quả, ScorePlus gọi endpoint SSO **backend** của AI-Portal `GET /api/scoreplus/session` (mặc định; đổi bằng `NEXT_PUBLIC_PORTAL_SCOREUP_SESSION_PATH`, path bắt đầu bằng `/`, không chứa base path). Endpoint (`AI-Portal/backend/src/routes/scoreplus.ts`) xác thực cookie phiên Portal, rồi gọi server-to-server ScoreUp `POST /v1/api/auth/portal` kèm header `x-portal-sso-secret`; ScoreUp tìm/tạo user theo email và cấp Bearer token. Cấu hình: AI-Portal `SCOREUP_API_URL` + `SCOREUP_PORTAL_SSO_SECRET`, ScoreUp `PORTAL_SSO_SECRET` (hai secret phải trùng nhau). Frontend không gửi email/id để thay thế xác thực. Lưu ý: ScoreUp chỉ giữ một token mỗi user, nên mở ScorePlus sẽ đăng xuất phiên ScoreUp web của cùng tài khoản (giống đăng nhập lại).

Frontend gọi `GET` endpoint với `credentials: same-origin`, `cache: no-store`; response cần là `{ metadata: { token: "..." } }` hoặc `{ token: "..." }`. Sau đó gọi ScoreUp `/user/info` để xác thực token. Token chỉ giữ trong bộ nhớ; mỗi lần mở lại sẽ lấy phiên mới. Không dùng token OAuth Microsoft/Google thay cho token ScoreUp. Khi endpoint lỗi hoặc Portal chưa cấu hình, tài khoản Portal vẫn hiển thị nhưng thao tác làm bài bị khóa kèm thông báo lỗi. Nút “Kết nối lại” lấy lại phiên từ Portal. Đổi tài khoản sẽ xóa lượt bài cũ để không lưu nhầm người dùng.

## Đóng gói cho AI Portal

```bash
cd ScorePlus/frontend
npm test
npm run pack
```

Upload `dist/scoreplus.zip` (từ thư mục `ScorePlus/frontend`) vào phần quản trị công cụ AI Portal. Cấu trúc ZIP:

```text
manifest.json
public/index.html
public/_next/...
```

Alias cố định là `scoreplus`, `hasFrontendOnly: true`, `hasBackend: false`. Gói chỉ chứa manifest và output tĩnh, không chứa source, `.env`, node_modules hay server. Script kiểm tra giới hạn 50 MB của Portal.

Portal ở domain root: để `PORTAL_BASE_PATH` rỗng. Portal dưới `/tuyen-sinh`: đặt `PORTAL_BASE_PATH=/tuyen-sinh`, build lại; URL sẽ là `/tuyen-sinh/embed/scoreplus/`. Cấu hình được đặt trong **ScorePlus/frontend**, không cần đổi Next config của AI Portal. Không cần sửa Docker Compose hoặc chạy `next start` cho gói tĩnh.

Với `https://ai.neu.edu.vn/apps/tools/scoreplus`, chạy `npm run pack:neu` rồi upload lại `dist/scoreplus.zip`. Lệnh này build với `PORTAL_BASE_PATH=/apps` và API/media HTTPS của ScoreUp tại `fit.neu.edu.vn/scoreup`, không thay đổi `.env.local`. CSS/JS của gói phải trỏ tới `/apps/embed/scoreplus/_next/...`; dùng gói local có `/embed/scoreplus/_next/...` trên website này sẽ làm mất giao diện.

URL `/apps/tools/scoreplus` là trang bọc của Portal; base path của bản ScorePlus tĩnh là `/apps/embed/scoreplus`. Khi đóng gói cho local vẫn dùng `npm run pack`. API ScoreUp production cần cho phép CORS từ origin `https://ai.neu.edu.vn` để tải môn học và gọi API luyện tập.

Tool có một route tĩnh; chọn môn/chương và làm bài bằng client state để tránh refresh route động bị 404. Có thể mở `?subject=MA_MON` để chọn sẵn môn. Theme lấy từ `?theme=dark|light` và sự kiện `portal-theme` chỉ từ parent cùng origin. Không sử dụng `apiProxyTarget` vì router Portal hiện tự nối `/api` và vẫn để browser gọi trực tiếp BE.

## Phạm vi

- Chọn môn, luyện ngẫu nhiên hoặc một chương, 5–50 câu mỗi lượt.
- Có thể yêu cầu gia sư AI đưa gợi ý cho từng câu qua endpoint Central LLM của AI Portal. AI chỉ nhận nội dung câu hỏi, lựa chọn và lựa chọn hiện tại (nếu có); không gửi thông tin tài khoản. Cần cấu hình Central LLM trong AI Portal. Gợi ý không thay thế đáp án/chấm điểm ScoreUp và có thể sai.
- Câu hỏi dạng unified/legacy, Markdown, bảng, code, ảnh và audio; không thực thi HTML từ nội dung câu hỏi.
- Đáp án hiện sau từng câu hoặc khi nộp; bảng tiến độ, thêm câu mới, loại câu trùng.
- Nộp bài lưu đúng schema result ScoreUp; khóa nút khi request chạy và sau khi lưu thành công.
- Responsive, hỗ trợ sáng/tối; thông báo lỗi mạng, phiên hết hạn, dữ liệu rỗng.

Đây là tool luyện tập, không bao gồm quản trị đề, bình luận, chia sẻ bộ câu, hệ gợi ý thích nghi hoặc đăng nhập Microsoft. Chấm điểm phía client theo đáp án API, cùng cách trang luyện tập hiện tại; không dùng làm hệ thống thi bảo mật. Khi bắt đầu lượt mới, app xác nhận trước khi bỏ bài chưa nộp; khi Portal đổi tài khoản, lượt bài cũ bị xóa. Bài chưa nộp không được khôi phục sau khi refresh. Nếu mất mạng ngay sau nộp, BE chưa có idempotency key nên cần kiểm tra lịch sử ScoreUp trước khi thử lại để tránh bản ghi trùng.

## Kiểm tra triển khai

Sau khi upload, kiểm tra tải JS/CSS, kiểm tra nhận tài khoản Portal và lấy phiên SSO bằng tài khoản thử nghiệm, chọn môn/chương, trả lời/nộp bài và xác nhận kết quả trong ScoreUp. `npm test` dùng mock API, không ghi dữ liệu vào server thật. Build và test local không thay thế kiểm thử CORS/tài khoản trên môi trường triển khai.
