function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

// Keep the HTML in a TypeScript string so Workers and Node tests use the same
// bundled template without filesystem access or a separate template build.
export function renderMarketingEmail(subject: string, message: string): string {
  const title = escapeHtml(subject);
  const content = escapeHtml(message).replace(/\r\n?|\n/g, "<br>\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${title}</title>
  <style>
    a:focus-visible { outline:2px solid #80aaff;outline-offset:4px; }
    @media screen and (max-width:600px) {
      .email-shell { padding:16px 8px !important; }
      .email-section { padding-right:24px !important;padding-left:24px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#0d1014;color:#f2f4f7;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0d1014" style="width:100%;border-collapse:collapse;">
    <tr>
      <td class="email-shell" align="center" style="padding:32px 16px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#141920" style="width:100%;max-width:600px;table-layout:fixed;border-collapse:collapse;background-color:#141920;">
          <tr>
            <td class="email-section" style="padding:24px 32px;border-bottom:1px solid #2b323b;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr>
                  <td width="44" valign="middle">
                    <a href="https://mainbrella.com" aria-label="Mainbrella home" style="display:block;">
                      <img src="https://mainbrella.com/images/logo.png" alt="Mainbrella umbrella" width="44" height="44" style="display:block;width:44px;height:44px;border:0;">
                    </a>
                  </td>
                  <td valign="middle" style="padding-left:12px;font-size:22px;line-height:28px;font-weight:700;letter-spacing:-0.03em;">
                    <a href="https://mainbrella.com" style="color:#f2f4f7;text-decoration:none;">mainbrella</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="email-section" style="padding:32px;color:#f2f4f7;overflow-wrap:anywhere;word-break:break-word;">
              <h1 style="margin:0 0 20px;font-size:24px;line-height:1.3;font-weight:700;">${title}</h1>
              <div style="font-size:16px;line-height:1.6;">${content}</div>
            </td>
          </tr>
          <tr>
            <td class="email-section" bgcolor="#0d1014" style="padding:24px 32px;border-top:1px solid #2b323b;background-color:#0d1014;color:#a4adb8;font-size:13px;line-height:1.6;">
              <p style="margin:0;"><a href="https://mainbrella.com" style="color:#f2f4f7;font-size:15px;font-weight:700;text-decoration:none;">mainbrella.com</a></p>
              <p style="margin:4px 0 12px;">Cloud computers for AI agents.</p>
              <p style="margin:0 0 12px;">
                <a href="https://mainbrella.com/docs/" style="display:inline-block;padding:12px 0;color:#80aaff;text-decoration:underline;">Docs</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
                <a href="https://mainbrella.com/blog/" style="display:inline-block;padding:12px 0;color:#80aaff;text-decoration:underline;">Blog</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
                <a href="https://mainbrella.com/contact/" style="display:inline-block;padding:12px 0;color:#80aaff;text-decoration:underline;">Contact</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
                <a href="https://mainbrella.com/privacy/" style="display:inline-block;padding:12px 0;color:#80aaff;text-decoration:underline;">Privacy</a>
              </p>
              <p style="margin:0;font-size:12px;">Mainbrella Co. &middot; Andrew Arrow<br>5427 Emporia Ave &middot; Culver City, CA 90230</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
}
