function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

// Keep the HTML in a TypeScript string so Workers and Node tests use the same
// bundled template without filesystem access or a separate template build.
export function renderMarketingEmail(subject: string, message: string): string {
  const content = escapeHtml(message).replace(/\r\n?|\n/g, "<br>\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;color:#242424;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" style="width:100%;max-width:600px;border-collapse:collapse;background-color:#ffffff;">
          <tr>
            <td style="padding:24px 24px 16px;font-size:20px;font-weight:bold;">
              <a href="https://mainbrella.com" style="color:#242424;text-decoration:none;">mainbrella</a>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px 32px;font-size:16px;line-height:1.6;overflow-wrap:anywhere;word-break:break-word;">${content}</td>
          </tr>
          <tr>
            <td style="padding:20px 24px;background-color:#f5f5f5;font-size:13px;line-height:1.5;">
              <a href="https://mainbrella.com" style="color:#555555;">mainbrella.com</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
