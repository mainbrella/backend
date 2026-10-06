import { authCorsHeaders, authJson, currentUser, type AuthUser } from "./auth-core";

const ADMIN_EMAIL = "oneone@gmail.com";
const PAGE_SIZE = 25;

type TableDefinition = {
  id: string;
  label: string;
  group: string;
  table: string;
  columns: string[];
  search: string[];
  order: string;
};

const TABLES: TableDefinition[] = [
  { id: "users", label: "Users", group: "Community", table: "users", columns: ["id", "username", "human_name", "email", "is_active", "current_herd_id", "created_at"], search: ["id", "username", "human_name", "email"], order: "created_at DESC, id DESC" },
  { id: "herds", label: "Herds", group: "Community", table: "herds", columns: ["id", "name", "city_id", "created_by", "media_enabled", "created_at", "updated_at"], search: ["id", "name", "city_id"], order: "created_at DESC, id DESC" },
  { id: "memberships", label: "Memberships", group: "Community", table: "herd_memberships", columns: ["herd_id", "user_id", "username", "role", "push_notifications_enabled", "joined_at", "last_seen_at"], search: ["herd_id", "user_id", "username"], order: "joined_at DESC, herd_id, user_id" },
  { id: "community-chat", label: "Community chat", group: "Community", table: "herd_chat_messages", columns: ["id", "herd_id", "user_id", "sent_at", "image_path"], search: ["herd_id", "user_id"], order: "sent_at DESC, id DESC" },
  { id: "direct-chats", label: "Direct chats", group: "Community", table: "herd_direct_messages", columns: ["id", "herd_id", "sender_id", "recipient_id", "sent_at", "image_path"], search: ["herd_id", "sender_id", "recipient_id"], order: "sent_at DESC, id DESC" },
  { id: "providers", label: "Providers", group: "Directory", table: "iop_providers", columns: ["id", "name", "website_url", "founded_year", "created_at", "updated_at"], search: ["id", "name", "website_url"], order: "created_at DESC, id DESC" },
  { id: "locations", label: "Locations", group: "Directory", table: "iop_locations", columns: ["id", "provider_id", "display_name", "city", "state", "publication_status", "phone", "created_at", "updated_at"], search: ["id", "provider_id", "display_name", "city", "state"], order: "created_at DESC, id DESC" },
  { id: "programs", label: "Programs", group: "Directory", table: "iop_programs", columns: ["id", "location_id", "name", "code", "publication_status", "created_at", "updated_at"], search: ["id", "location_id", "name", "code"], order: "created_at DESC, id DESC" },
  { id: "staff", label: "Staff", group: "Directory", table: "iop_staff", columns: ["id", "provider_id", "name", "credentials", "specialty", "created_at"], search: ["id", "provider_id", "name"], order: "created_at DESC, id DESC" },
  { id: "reviews", label: "Reviews", group: "Activity", table: "staff_reviews", columns: ["id", "user_id", "staff_id", "location_id", "unicorn_rating", "meeting_at", "created_at"], search: ["id", "user_id", "staff_id", "location_id"], order: "created_at DESC, id DESC" },
  { id: "tours", label: "Tour requests", group: "Activity", table: "program_tour_requests", columns: ["id", "user_id", "location_id", "location_name", "status", "agreed_time", "created_at"], search: ["id", "user_id", "location_id", "location_name"], order: "created_at DESC, id DESC" },
  { id: "tracked-programs", label: "Tracked programs", group: "Activity", table: "iop_program_tracks", columns: ["id", "user_id", "program_id", "status", "horn_rating", "created_at", "updated_at"], search: ["id", "user_id", "program_id"], order: "updated_at DESC, id DESC" },
];

export async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  const corsHeaders = authCorsHeaders(request);
  if (corsHeaders === null) return authJson({ error: "origin_not_allowed" }, 403, {});
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "GET") return authJson({ error: "method_not_allowed" }, 405, { ...corsHeaders, allow: "GET" });

  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: "unauthorized" }, 401, corsHeaders);
    if (user.email?.trim().toLowerCase() !== ADMIN_EMAIL) {
      return authJson({ error: "forbidden" }, 403, corsHeaders);
    }
    if (!env.DB) return authJson({ error: "database_unavailable" }, 503, corsHeaders);

    const url = new URL(request.url);
    if (url.pathname === "/admin/users") {
      const rows = await env.DB.prepare(
        "SELECT id, email, name, dob, created_at FROM users ORDER BY created_at DESC, id DESC",
      ).all<Pick<AuthUser, "id" | "email" | "name" | "dob" | "created_at">>();
      return authJson({ users: rows.results || [] }, 200, corsHeaders);
    }
    if (url.pathname === "/admin/tables") {
      return authJson({ tables: TABLES.map(({ id, label, group, columns }) => ({ id, label, group, columns })) }, 200, corsHeaders);
    }
    const match = /^\/admin\/tables\/([a-z-]+)$/.exec(url.pathname);
    const definition = TABLES.find((item) => item.id === match?.[1]);
    if (!definition) return authJson({ error: "not_found" }, 404, corsHeaders);

    const offsetText = url.searchParams.get("offset") || "0";
    const offset = Number(offsetText);
    if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) || offset > 1_000_000) {
      return authJson({ error: "invalid_offset" }, 400, corsHeaders);
    }
    const query = (url.searchParams.get("q") || "").trim();
    if (query.length > 100) return authJson({ error: "invalid_query" }, 400, corsHeaders);
    const filter = query ? ` WHERE (${definition.search.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})` : "";
    const term = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const filterArgs = query ? definition.search.map(() => term) : [];
    const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${definition.table}${filter}`)
      .bind(...filterArgs).first<{ total: number }>();
    const rows = await env.DB.prepare(
      `SELECT ${definition.columns.join(", ")} FROM ${definition.table}${filter}
       ORDER BY ${definition.order} LIMIT ? OFFSET ?`,
    ).bind(...filterArgs, PAGE_SIZE, offset).all<Record<string, unknown>>();
    return authJson({ items: rows.results || [], total: count?.total || 0, offset, limit: PAGE_SIZE }, 200, corsHeaders);
  } catch (error) {
    console.error("admin_read_error", error);
    return authJson({ error: "admin_unavailable" }, 503, corsHeaders);
  }
}
