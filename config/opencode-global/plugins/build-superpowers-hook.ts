const marker = 'SOC_BUILD_SUPERPOWERS_V2';
const instruction = "<!-- SOC_BUILD_SUPERPOWERS_V2 -->\n## SUPERPOWERS / TDD / DEBUGGING\n\n- Khi bắt đầu task thực thi mới, gọi skill using-superpowers nếu nội dung chưa được nạp trong context. Dùng skill tool thực sự có trong phiên; không chỉ nói rằng đang áp dụng.\n- Áp dụng skills trong scope và quyền Bố đã giao; không khởi động lại vòng brainstorming/xin duyệt cho công việc đã được chốt.\n- Với task thay đổi hành vi hoặc sửa bug, gọi test-driven-development trước khi sửa production code. Viết hoặc bổ sung regression, chạy xác nhận RED do đúng lỗi cần sửa, sửa tối thiểu rồi kiểm chứng GREEN.\n- Nếu code đã được sửa trước khi resume, giữ evidence RED còn hợp lệ hoặc kiểm chứng regression trên pre-fix source trong fixture riêng. Không hoàn tác công việc tốt chỉ để diễn lại TDD; không claim test-first khi không có evidence.\n- Với lỗi chưa rõ nguyên nhân, failure ngoài dự kiến hoặc cùng lỗi tái diễn, gọi systematic-debugging trước khi tiếp tục sửa. Tìm root cause và phép thử phân biệt; không vá theo phỏng đoán.\n- Trước khi báo hoàn tất/READY_FOR_REVIEW, gọi verification-before-completion; đối chiếu acceptance, tests/gates bắt buộc, diff, candidate binding và findings còn mở.\n- Giữ evidence đã PASS còn hợp lệ; không chạy lại full suite chỉ vì nạp skill. Sửa documentation/config thuần không phải tạo regression RED giả.\n- Nếu skill thiếu hoặc bị deny, báo đúng lỗi và phần chưa xác minh; không giả đã gọi, không đổi quyền hoặc tự cài plugin để lách.\n- Theo dõi tiến độ theo policy TODO hiện có; dùng tool thực tế nếu có, nếu không thì checklist trong hội thoại.\n<!-- END_SOC_BUILD_SUPERPOWERS_V2 -->";

export default {
  id: 'build-superpowers-hook',
  async setup(ctx) {
    if (typeof ctx?.session?.hook !== 'function') {
      throw new Error('[build-superpowers-hook] OpenCode V2 session.hook unavailable');
    }

    await ctx.session.hook('context', async (event) => {
      if (event.agent !== 'build' || !Array.isArray(event.messages)) return;

      const present = event.messages.some(m =>
        Array.isArray(m.content) && m.content.some(p =>
          p.type === 'text' &&
          typeof p.text === 'string' &&
          p.text.includes(marker)
        )
      );
      if (present) return;

      const user = event.messages.find(m =>
        m.role === 'user' && Array.isArray(m.content)
      );

      if (user) {
        user.content.unshift({ type: 'text', text: instruction });
      } else {
        event.messages.push({
          role: 'user',
          content: [{ type: 'text', text: instruction }]
        });
      }
    });
  }
};
