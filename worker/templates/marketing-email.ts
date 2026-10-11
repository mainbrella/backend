function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

const footerGroups: [string, [string, string][]][] = [
  ["Product", [["Containers", "/docs/containers/"], ["Images", "/docs/images/"], ["Pricing", "/pricing/"]]],
  ["Developers", [["Docs", "/docs/"], ["API reference", "/docs/api-reference/"], ["GitHub", "https://github.com/mainbrella"]]],
  ["Company", [["About", "/about/"], ["Contact", "/contact/"], ["Blog", "/blog/"]]],
  ["Legal", [["Privacy", "/privacy/"], ["Terms", "/terms/"], ["Subprocessors", "/subprocessors/"]]],
];

// Keep the HTML in a TypeScript string so Workers and Node tests use the same
// bundled template without filesystem access or a separate template build.
export function renderMarketingEmail(subject: string, message: string): string {
  const title = escapeHtml(subject);
  const content = escapeHtml(message).replace(/\r\n?|\n/g, "<br>\n");
  const footerColumns = footerGroups.map(([heading, links]) => `
    <td width="50%" valign="top" style="width:50%;padding-right:12px;">
      <h2 style="margin:0 0 8px;color:#f2f4f7;font-size:13px;line-height:24px;font-weight:700;">${heading}</h2>
      ${links.map(([label, path]) => `<a href="${path.startsWith("/") ? `https://mainbrella.com${path}` : path}" style="display:block;padding:10px 0;color:#a4adb8;line-height:24px;text-decoration:none;">${label}</a>`).join("\n      ")}
    </td>`);
  const footerPairs = [footerColumns.slice(0, 2), footerColumns.slice(2)].map(columns => `
    <div class="footer-pair" style="display:inline-block;width:100%;max-width:230px;vertical-align:top;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:12px;line-height:1.6;">
        <tr>${columns.join("")}</tr>
      </table>
    </div>`).join('<!--[if mso]></td><td width="230" valign="top"><![endif]-->');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${title}</title>
  <style>
    a:hover { color:#ffad70 !important; }
    .email-button:hover { background-color:#913900 !important;color:#ffffff !important; }
    a:focus-visible { outline:2px solid #ffad70;outline-offset:4px; }
    @media screen and (max-width:700px) {
      .email-shell { padding:16px 8px !important; }
      .email-section { padding-right:24px !important;padding-left:24px !important; }
      .email-title { font-size:28px !important; }
      .footer-intro, .footer-navigation { display:block !important;width:100% !important;max-width:none !important;padding:0 !important; }
      .footer-navigation { padding-top:24px !important; }
      .footer-pair { display:block !important;width:100% !important;max-width:none !important; }
      .footer-pair + .footer-pair { padding-top:20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#0d1014;color:#f2f4f7;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0d1014" style="width:100%;border-collapse:collapse;">
    <tr>
      <td class="email-shell" align="center" style="padding:24px 16px;">
        <!--[if mso]><table role="presentation" width="760" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0d1014" style="width:100%;max-width:760px;table-layout:fixed;border-collapse:collapse;background-color:#0d1014;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
          <tr>
            <td class="email-section" style="padding:20px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
                <tr>
                  <td valign="middle">
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
                  <td align="right" valign="middle" style="font-size:13px;line-height:20px;white-space:nowrap;">
                    <a href="https://mainbrella.com/docs/" style="display:inline-block;padding:12px 0;color:#f2f4f7;text-decoration:none;">Docs</a>&nbsp;&nbsp;&nbsp;
                    <a href="https://mainbrella.com/pricing/" style="display:inline-block;padding:12px 0;color:#f2f4f7;text-decoration:none;">Pricing</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="email-section" bgcolor="#10151b" style="padding:40px;background-color:#10151b;color:#f2f4f7;overflow-wrap:anywhere;word-break:break-word;">
              <h1 class="email-title" style="margin:0 0 24px;font-size:32px;line-height:1.15;font-weight:700;letter-spacing:-0.02em;">${title}</h1>
              <div style="color:#a4adb8;font-size:17px;line-height:1.65;">${content}</div>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px;border-collapse:collapse;">
                <tr>
                  <td bgcolor="#ad4400" style="border-radius:6px;background-color:#ad4400;mso-padding-alt:12px 20px;">
                    <a class="email-button" href="https://mainbrella.com/pricing/usage/" style="display:inline-block;padding:12px 20px;border-radius:6px;background-color:#ad4400;color:#ffffff;font-size:15px;line-height:24px;font-weight:600;text-decoration:none;">Start building</a>
                  </td>
                  <td style="padding-left:20px;font-size:14px;line-height:24px;">
                    <a href="https://mainbrella.com/docs/" style="display:inline-block;padding:12px 0;color:#ffad70;text-decoration:none;">Quickstart&nbsp;&rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="email-section" bgcolor="#0d1014" style="padding:32px 40px;border-top:1px solid #2b323b;background-color:#0d1014;color:#a4adb8;font-size:12px;line-height:1.6;overflow-wrap:anywhere;word-break:break-word;">
              <div style="font-size:0;line-height:0;">
                <!--[if mso]><table role="presentation" width="680" cellpadding="0" cellspacing="0"><tr><td width="220" valign="top"><![endif]-->
                <div class="footer-intro" style="display:inline-block;box-sizing:border-box;width:100%;max-width:220px;padding-right:24px;padding-bottom:24px;vertical-align:top;font-size:12px;line-height:1.6;">
                    <a href="https://mainbrella.com" style="color:#f2f4f7;font-size:18px;line-height:24px;font-weight:700;letter-spacing:-0.03em;text-decoration:none;">mainbrella</a>
                    <p style="margin:8px 0 12px;">Cloud computers for AI agents.</p>
                    <p style="margin:0;">Mainbrella Co. &middot; Sole proprietorship<br>Andrew Arrow &middot; Culver City, California</p>
                    <p style="margin:8px 0;">5427 Emporia Ave<br>Culver City, CA 90230</p>
                    <p style="margin:0;">
                      <a href="https://www.tiktok.com/@mainbrella" style="display:inline-block;padding:12px 0;color:#a4adb8;text-decoration:none;">TikTok</a>&nbsp;&nbsp;
                      <a href="https://github.com/mainbrella" style="display:inline-block;padding:12px 0;color:#a4adb8;text-decoration:none;">GitHub</a>&nbsp;&nbsp;
                      <a href="https://www.youtube.com/@mainbrella" style="display:inline-block;padding:12px 0;color:#a4adb8;text-decoration:none;">YouTube</a>
                    </p>
                </div>
                <!--[if mso]></td><td width="460" valign="top"><![endif]-->
                <div class="footer-navigation" style="display:inline-block;width:100%;max-width:460px;vertical-align:top;">
                  <!--[if mso]><table role="presentation" width="460" cellpadding="0" cellspacing="0"><tr><td width="230" valign="top"><![endif]-->
                  ${footerPairs}
                  <!--[if mso]></td></tr></table><![endif]-->
                </div>
                <!--[if mso]></td></tr></table><![endif]-->
              </div>
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
