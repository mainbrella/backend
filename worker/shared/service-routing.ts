// Public paths stay on api.mainbrella.com so existing host-only session cookies
// and clients continue to work across independently deployed Workers.
export function serviceForPath(path: string): "admin" | "marketing" | null {
  if (path.startsWith("/admin/") || path === "/api/get-marketing-users") return "admin";
  if (path === "/api/send-marketing-email" || path === "/api/unsubscribe") return "marketing";
  return null;
}
