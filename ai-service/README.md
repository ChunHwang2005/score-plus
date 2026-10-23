# ScorePlus AI Service

Đây là vị trí phát triển dịch vụ gia sư AI của ScorePlus, đặt ngang cấp với `frontend/`. Hiện thư mục này mới là khung cấu trúc; API/model chưa được triển khai.

## Mục tiêu

Xây gia sư tạo gợi ý sư phạm từng bước cho câu hỏi đa môn. Gia sư xét môn/chủ đề, nội dung câu hỏi, lựa chọn của sinh viên và số lần yêu cầu gợi ý; không thay thế đáp án chuẩn hoặc việc chấm điểm của ScoreUp.

## Cấu trúc dự kiến

- `app/`: API gia sư và lớp tích hợp mô hình ngôn ngữ.
- `models/`: bộ phân loại lỗi/nhu cầu hỗ trợ và chính sách chọn cấp độ gợi ý.
- `data/`: dữ liệu được phép sử dụng, nhãn lỗi và cấu hình môn học. Không đưa dữ liệu cá nhân/nhạy cảm vào Git.
- `training/`: xử lý dữ liệu, huấn luyện hoặc fine-tune khi đã có tập nhãn phù hợp.
- `evaluation/`: bộ đánh giá chất lượng gợi ý và tác động sửa sai.

## Trình tự triển khai

1. Chốt với giảng viên dữ liệu, môn/chủ đề, nhãn lỗi và quy trình thử nghiệm.
2. Tạo API có kiểm tra đầu vào và chính sách gợi ý theo tầng.
3. Bổ sung mô hình học từ dữ liệu gán nhãn nếu dữ liệu đủ; không cần huấn luyện LLM từ đầu.
4. Đánh giá chuyên môn đầu ra trước khi thử nghiệm với sinh viên.
5. Tích hợp `frontend/` gọi API và triển khai API như service riêng khi cần.

Chưa có lệnh chạy cho tới khi framework/API được chọn và triển khai.
