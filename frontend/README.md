# ScorePlus

Ứng dụng Next.js (export tĩnh) cho AI Portal, dựa trên luồng **Luyện tập sinh viên** của ScoreUp. Không có navbar, không cần database riêng; gói Portal gộp kèm [ai-service](../ai-service/README.md) làm backend gia sư AI.

## Chạy local

Yêu cầu Node.js >= 20.9 và npm.

```bash
cd ScorePlus/frontend
npm install
# Chỉ tạo .env.local nếu chưa có (không ghi đè cấu hình hiện tại):
test -f .env.local || cp .env.example .env.local
npm run dev
```

Mở http://localhost:3000/ . Chế độ dev chạy ở đường dẫn gốc; link cũ `/embed/scoreplus/` sẽ chuyển về `/`. Khi đóng gói cho local bằng `npm run pack:local`, ứng dụng dùng `/embed/scoreplus/`; `npm run pack` mặc định build cho website NEU dưới `/apps`. Sau khi thay đổi `next.config.mjs`, hãy dừng và chạy lại `npm run dev`.

`.env.example` mặc định gọi BE local tại `http://localhost:3006/v1/api`. Nếu dùng server ScoreUp có sẵn, chỉnh `.env.local` theo mục bên dưới. Không copy đè `.env.local` đã cấu hình. API danh sách môn trên server đã được kiểm tra trả HTTP 200, nhưng preflight từ `http://localhost:3000` chưa có `Access-Control-Allow-Origin`: quản trị BE cần thêm origin local/Portal vào CORS trước khi trình duyệt gọi được.

## Kết nối ScoreUp

Chỉnh `.env.local` trước khi build:

```dotenv
NEXT_PUBLIC_SCOREUP_API_URL=https://fit.neu.edu.vn/scoreup/v1/api
NEXT_PUBLIC_SCOREUP_MEDIA_URL=https://fit.neu.edu.vn/scoreup/media/
PORTAL_BASE_PATH=
```

URL trên là ví dụ theo cấu hình ScoreUp trong workspace; cần xác nhận URL media thực tế của môi trường triển khai. Các biến `NEXT_PUBLIC_*` là công khai, được nhúng lúc build; thay đổi URL cần build và upload lại. Không đặt mật khẩu, token hoặc secret vào các biến này.

BE ScoreUp phải cho phép origin của Portal (và `http://localhost:3000` khi dev) trong `CORS_ALLOWED_ORIGINS`, ví dụ `https://portal.example.com,http://localhost:3000`. Origin không chứa path. Request dùng Bearer, không dùng cookie xuyên domain. Khi Portal chạy HTTPS, API và media cũng cần HTTPS.

Các API được sử dụng (đã đối chiếu source ScoreUp):

| API | Chức năng |
| --- | --- |
| `GET /user/info` | Kiểm tra token và lấy người dùng |
| `GET /subjects/?visible_for_practice_only=1` | Môn học và danh sách chương |
| `POST /questions` | Lấy câu hỏi với `subject_id`, `chapter_id`, `limit` |
| `POST /questions/result` | Lưu kết quả, BE lấy user từ Bearer token; `idempotency_key` (hoặc header `Idempotency-Key`) chống ghi trùng |

Ứng dụng nhận tài khoản AI-Portal từ `window.__PORTAL_USER__` hoặc postMessage `{ type: 'PORTAL_USER', user: { id, email, name } }`, đồng thời gửi `PORTAL_APP_NEED_USER` khi mở iframe và gọi `GET /api/auth/session` với cookie cùng origin để lấy tài khoản trực tiếp. Trên `ai.neu.edu.vn/apps`, URL được tự ghép thành `https://ai.neu.edu.vn/apps/api/auth/session`. Frontend chỉ giữ `{ id, email, name }`, bỏ `accessToken`, `profile`, `image` và `is_admin`. Endpoint session trả thông tin đăng nhập Portal, không cấp token ScoreUp; không đặt `/api/auth/session` vào biến `NEXT_PUBLIC_PORTAL_SCOREUP_SESSION_PATH`. Chỉ nhận message từ parent cùng origin. Không có nút/form đăng nhập hoặc đăng xuất riêng; tài khoản được quản lý ở Portal.

User context của Portal không phải token ScoreUp. Để làm bài/lưu kết quả, ScorePlus gọi endpoint SSO **backend** của AI-Portal `GET /api/scoreplus/session` (mặc định; đổi bằng `NEXT_PUBLIC_PORTAL_SCOREUP_SESSION_PATH`, path bắt đầu bằng `/`, không chứa base path). Endpoint (`AI-Portal/backend/src/routes/scoreplus.ts`) xác thực cookie phiên Portal, rồi gọi server-to-server ScoreUp `POST /v1/api/auth/portal` kèm header `x-portal-sso-secret`; ScoreUp tìm/tạo user theo email và cấp Bearer token. Cấu hình: AI-Portal `SCOREUP_API_URL` + `SCOREUP_PORTAL_SSO_SECRET`, ScoreUp `PORTAL_SSO_SECRET` (hai secret phải trùng nhau). Frontend không gửi email/id để thay thế xác thực. Nếu Portal chưa có endpoint này (404/5xx), ScorePlus dùng **dự phòng**: lấy `accessToken` Microsoft trong `/api/auth/session` của Portal (user đăng nhập Portal bằng Microsoft) và gửi ScoreUp `POST /v1/api/auth/microsoft/token`; ScoreUp xác minh token với Microsoft Graph, chỉ nhận token của tenant NEU và đúng app Azure (`TENANT_ID`/`CLIENT_ID`), rồi cấp token ScoreUp. Không cần sửa Portal, nhưng token Microsoft của Portal hết hạn khoảng 1 giờ sau khi đăng nhập Portal; khi đó ScorePlus báo đăng xuất/đăng nhập lại Portal. Tài khoản Portal không đăng nhập bằng Microsoft không dùng được dự phòng. Lưu ý: ScoreUp chỉ giữ một token mỗi user, nên mở ScorePlus sẽ đăng xuất phiên ScoreUp web của cùng tài khoản (giống đăng nhập lại).

Frontend gọi `GET` endpoint với `credentials: same-origin`, `cache: no-store`; response cần là `{ metadata: { token: "..." } }` hoặc `{ token: "..." }`. Sau đó gọi ScoreUp `/user/info` để xác thực token. Token chỉ giữ trong bộ nhớ; mỗi lần mở lại sẽ lấy phiên mới. Không dùng token OAuth Microsoft/Google thay cho token ScoreUp. Khi endpoint lỗi hoặc Portal chưa cấu hình, tài khoản Portal vẫn hiển thị nhưng thao tác làm bài bị khóa kèm thông báo lỗi. Nút “Kết nối lại” lấy lại phiên từ Portal. Đổi tài khoản sẽ xóa lượt bài cũ để không lưu nhầm người dùng.

## Chạy riêng (không qua Portal)

Khi mở ScorePlus ngoài đường dẫn `/embed/scoreplus` của Portal và không nằm trong iframe (vd. `npm run dev` tại http://localhost:3000/), app hiện nút **Đăng nhập với Microsoft (NEU)** và đăng nhập giống ScoreUp: chuyển sang Microsoft (Web code flow, cùng app Azure), nhận `code` tại redirect URI rồi gửi ScoreUp `POST /auth/microsoft/code` để BE ScoreUp đổi lấy token (BE dùng `APP_SECRET`, frontend không giữ secret). Token giữ trong `sessionStorage` của tab để reload không phải đăng nhập lại; nút “Đăng xuất” xoá token.

Cấu hình trong `.env.local`: `NEXT_PUBLIC_MICROSOFT_CLIENT_ID`, `NEXT_PUBLIC_MICROSOFT_TENANT_ID`, `NEXT_PUBLIC_MICROSOFT_REDIRECT_URI` (trống = `<origin>/`). Redirect URI phải được đăng ký trong Azure → Authentication → Web, khớp từng ký tự, nếu không Microsoft báo `AADSTS50011`. Local dùng URI đã đăng ký sẵn `http://localhost:3000/api/auth/callback/azure-ad` (dev server tự chuyển path này về `/` kèm `?code&state`). Cổng 3000 trùng AI-Portal và ScoreUp frontend khi dev: chỉ chạy một trong ba cùng lúc. Khi chạy riêng, gợi ý AI cần ai-service (`NEXT_PUBLIC_SCOREPLUS_AI_URL`); Central LLM của Portal không dùng được ngoài Portal.

## Đóng gói cho AI Portal

```bash
cd ScorePlus/frontend
npm test
npm run pack
```

Upload `dist/scoreplus.zip` (từ thư mục `ScorePlus/frontend`) ở **Admin → Công cụ → Cài từ gói** của AI Portal. Gói có backend nên chỉ quản trị cài được; "Cài từ file (chỉ mình tôi)" không nhận gói này. Cấu trúc ZIP:

```text
manifest.json          // alias scoreplus, hasBackend: true
package.json           // sinh từ ai-service/package.json (không có dependency)
public/index.html      // output tĩnh của Next
public/_next/...
dist/embed.js          // ai-service/portal/embed.js — Portal mount tại /api/apps/scoreplus
dist/server.js         // ai-service/portal/server.js — chạy standalone
app/, models/          // mã ai-service
.env                   // chỉ khi có ai-service/.env.portal
```

Alias cố định là `scoreplus`. Frontend gọi `POST <base path Portal>/api/apps/scoreplus/v1/hint` (base path lấy như các API Portal khác qua `portalApiPath`, vd. `/apps/api/apps/scoreplus`; không dùng `window.__WRITE_API_BASE__` vì sau reverse proxy giá trị này thiếu `/apps`) nên cùng origin với Portal, không cần CORS hay HTTPS riêng cho ai-service. Script kiểm tra giới hạn 50 MB của Portal.

Khóa LLM (chọn một):

- Tạo `ai-service/.env.portal` (cùng định dạng `.env.example`, đã gitignore) trước khi `npm run pack`; script đưa vào gói thành `.env`. Gói khi đó chứa khóa, không chia sẻ công khai.
- Hoặc đặt biến `SCOREPLUS_<TÊN>` trên server AI Portal, vd. `SCOREPLUS_LLM_API_KEY`, `SCOREPLUS_LLM_MODEL`; giá trị này ghi đè `.env` trong gói. App nhúng không đọc biến không có tiền tố của Portal.

Log gợi ý nằm ở `backend/data/app-logs/scoreplus` của Portal (không bị xoá khi cài lại gói).

Portal local ở domain root: dùng `npm run pack:local`, output `dist/scoreplus-local.zip`. Portal khác dưới `/tuyen-sinh`: đặt `PORTAL_BASE_PATH=/tuyen-sinh` và dùng `npm run pack:custom`; URL sẽ là `/tuyen-sinh/embed/scoreplus/`. Cấu hình được đặt trong **ScorePlus/frontend**, không cần đổi Next config của AI Portal. Không cần sửa Docker Compose hoặc chạy `next start` cho gói tĩnh.

Với `https://ai.neu.edu.vn/apps/tools/scoreplus`, chạy `npm run pack` (hoặc `npm run pack:neu`) rồi upload lại `dist/scoreplus.zip` hoặc `dist/scoreplus-neu.zip`. Lệnh này build với `PORTAL_BASE_PATH=/apps` và API/media HTTPS của ScoreUp tại `fit.neu.edu.vn/scoreup`, không thay đổi `.env.local`. CSS/JS của gói phải trỏ tới `/apps/embed/scoreplus/_next/...`; dùng gói local có `/embed/scoreplus/_next/...` trên website này sẽ làm mất giao diện.

URL `/apps/tools/scoreplus` là trang bọc của Portal; base path của bản ScorePlus tĩnh là `/apps/embed/scoreplus`. Khi đóng gói cho local dùng `npm run pack:local`; gói local không ghi đè ZIP production. Script đóng gói kiểm tra base path và sự tồn tại của CSS/JS trước khi tạo ZIP. API ScoreUp production cần cho phép CORS từ origin `https://ai.neu.edu.vn` để tải môn học và gọi API luyện tập.

Tool có một route tĩnh; chọn môn/chương và làm bài bằng client state để tránh refresh route động bị 404. Có thể mở `?subject=MA_MON` để chọn sẵn môn. Theme lấy từ `?theme=dark|light` và sự kiện `portal-theme` chỉ từ parent cùng origin. Không sử dụng `apiProxyTarget` vì router Portal hiện tự nối `/api` và vẫn để browser gọi trực tiếp BE.

## Phạm vi

- Chọn môn, luyện ngẫu nhiên hoặc một chương, 5–50 câu mỗi lượt.
- Có thể yêu cầu gia sư AI đưa gợi ý cho từng câu. App gọi `POST /v1/hint` của [ScorePlus AI service](../ai-service/README.md) (gợi ý 3 cấp theo trạng thái làm bài, model vLLM `qwen3.5-35b-a3b-int4`): khi dev qua `NEXT_PUBLIC_SCOREPLUS_AI_URL`, trong gói Portal qua ai-service nhúng; không có cả hai thì dùng endpoint Central LLM của AI Portal. AI chỉ nhận nội dung câu hỏi, đoạn mã, lựa chọn, giải thích tham khảo và lựa chọn hiện tại (nếu có); không gửi thông tin tài khoản. Gợi ý không thay thế đáp án/chấm điểm ScoreUp và có thể sai.
- Thực nghiệm với sinh viên: khi lớp học phần thuộc một đợt đang mở trên ScoreUp (`GET /tutor-experiments/me`), app hỏi đồng ý tham gia; với sinh viên đã đồng ý, chế độ làm bài cố định theo nhóm: nhóm có gia sư dùng phản hồi ngay và gợi ý AI, nhóm đối chứng làm như bài thi (nộp mới biết kết quả). Sinh viên từ chối dùng ScorePlus như bình thường. App hiện thang đánh giá gợi ý 1–5 và gửi sự kiện luyện tập theo lô (chỉ khi đã đồng ý). ScoreUp chưa có API này thì app hoạt động như bình thường. Xem `ScoreUP/ScoreUp/backend-api/docs/tutor-experiment.md`.
- Câu hỏi dạng unified/legacy, Markdown, bảng, code, ảnh và audio; không thực thi HTML từ nội dung câu hỏi.
- Đáp án hiện khi nộp, hoặc ở chế độ "Phản hồi ngay": chọn sai được thử lại tối đa 3 lần (đáp án hiện khi đúng hoặc hết lượt), điểm lưu ScoreUp tính theo lựa chọn cuối: đúng trong tối đa 3 lần thử thì tính đúng, sai cả 3 lần thì tính sai. Các lần thử được lưu kèm (`tries`) để Lịch sử hiện "Đúng ở lần thử 2" / "Sai cả 3 lần" và đánh dấu phương án đã thử sai. Bảng tiến độ, thêm câu mới, loại câu trùng.
- Nộp bài lưu đúng schema result ScoreUp; khóa nút khi request chạy và sau khi lưu thành công.
- Responsive, hỗ trợ sáng/tối; thông báo lỗi mạng, phiên hết hạn, dữ liệu rỗng.

Đây là tool luyện tập, không bao gồm quản trị đề, bình luận, chia sẻ bộ câu, hệ gợi ý thích nghi hoặc đăng nhập Microsoft khi chạy trong Portal (tài khoản lấy từ Portal). Chấm điểm phía client theo đáp án API, cùng cách trang luyện tập hiện tại; không dùng làm hệ thống thi bảo mật. Khi bắt đầu lượt mới, app xác nhận trước khi bỏ bài chưa nộp; khi Portal đổi tài khoản, lượt bài cũ bị xóa. Bài chưa nộp không được khôi phục sau khi refresh. Lần nộp gửi kèm `idempotency_key` (id lượt làm); nếu mất mạng ngay sau nộp, bấm nộp lại sẽ nhận về kết quả đã lưu thay vì tạo bản ghi trùng (ScoreUp có unique index `(user, idempotency_key)` trên `results`).

## Kiểm tra triển khai

Sau khi upload, kiểm tra tải JS/CSS, kiểm tra nhận tài khoản Portal và lấy phiên SSO bằng tài khoản thử nghiệm, chọn môn/chương, trả lời/nộp bài và xác nhận kết quả trong ScoreUp. `npm test` dùng mock API, không ghi dữ liệu vào server thật. Build và test local không thay thế kiểm thử CORS/tài khoản trên môi trường triển khai.
