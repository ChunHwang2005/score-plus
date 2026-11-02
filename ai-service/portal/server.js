// Điểm vào standalone mà gói Portal bắt buộc có (dist/server.js); khi nhúng, Portal chỉ nạp dist/embed.js.
import { startServer } from '../app/server.mjs';

startServer();
