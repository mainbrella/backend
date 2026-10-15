import { z } from 'zod';
import { boundedPrivateBody } from '../../containers/private-services-contract.js';
import { authCorsHeaders, authJson, currentUser } from './auth-core';

export const numberSearchInput = z.object({
  country: z.enum(['US', 'CA']).default('US'),
  query: z.string().trim().max(32).regex(/^[a-z0-9 ()-]*$/i).default(''),
  areaCode: z.string().regex(/^[2-9]\d{2}$/).optional(),
  match: z.enum(['ends_with', 'contains', 'starts_with']).default('ends_with'),
  type: z.enum(['local', 'toll-free']).default('local'),
  locality: z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N} .'-]+$/u).optional(),
  region: z.string().regex(/^[A-Z]{2}$/).optional(),
  includeSimilar: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(50).default(50),
}).strict();

const keypad: Record<string, string> = Object.fromEntries(
  ['ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ'].flatMap((letters, index) =>
    [...letters].map(letter => [letter, String(index + 2)])),
);
export const numberSearchDigits = (value: string): string => value.toUpperCase().replace(/[A-Z]/g, letter => keypad[letter]).replace(/[^0-9]/g, '');

const money = z.string().regex(/^\d{1,6}(?:\.\d{1,6})?$/).nullable();
const costSchema = z.object({ monthly: money, upfront: money, currency: z.string().regex(/^[A-Z]{3}$/) });
export const numberSearchResponse = z.object({
  search: numberSearchInput.extend({ digits: z.string() }),
  numbers: z.array(z.object({
    phoneNumber: z.string().regex(/^\+1\d{10}$/),
    location: z.string(), exactMatch: z.boolean(),
    cost: costSchema.nullable(),
  })).max(50),
});

const providerRow = z.object({
  phone_number: z.string().max(32), best_effort: z.boolean().optional(),
  features: z.array(z.object({ name: z.string().max(64) })).max(32).optional(),
  region_information: z.array(z.object({ region_type: z.string().max(64), region_name: z.string().max(128) })).max(16).optional(),
  cost_information: z.unknown().optional(),
});
type Search = z.infer<typeof numberSearchInput>;

export function matchesNumberPattern(phoneNumber: string, search: Pick<Search, 'areaCode' | 'match'>, digits: string): boolean {
  const national = phoneNumber.slice(2);
  if (search.areaCode && national.slice(0, 3) !== search.areaCode) return false;
  const target = search.areaCode ? national.slice(3) : national;
  return !digits || (search.match === 'starts_with' ? target.startsWith(digits)
    : search.match === 'ends_with' ? target.endsWith(digits) : target.includes(digits));
}

export async function searchVoiceNumbers(env: Env, search: Search, fetcher: typeof fetch = fetch): Promise<z.infer<typeof numberSearchResponse>> {
  const digits = numberSearchDigits(search.query);
  const url = new URL('https://api.telnyx.com/v2/available_phone_numbers');
  const filters: Record<string, string> = {
    country_code: search.country, phone_number_type: search.type === 'toll-free' ? 'toll_free' : 'local',
    'features[]': 'voice', limit: String(search.limit),
    best_effort: search.includeSimilar, exclude_held_numbers: 'true',
  };
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set(key === 'features[]' ? 'filter[features][]' : `filter[${key}]`, value);
  }
  if (digits) url.searchParams.set(`filter[phone_number][${search.match}]`, digits);
  if (search.areaCode) url.searchParams.set('filter[national_destination_code]', search.areaCode);
  if (search.locality) url.searchParams.set('filter[locality]', search.locality);
  if (search.region) url.searchParams.set('filter[administrative_area]', search.region);

  const response = await fetcher(url, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12_000),
    headers: { authorization: `Bearer ${env.TELNYX_API_KEY}`, accept: 'application/json' },
  });
  if (!response.ok) {
    console.warn('voice_number_search_provider_failed', response.status);
    throw new NumberSearchError(response.status === 429 ? 'number_search_rate_limited' : [400, 422].includes(response.status)
      ? 'number_search_rejected' : 'number_search_unavailable', response.status === 429 ? 429 : [400, 422].includes(response.status) ? 400 : 503);
  }
  const payload = z.object({ data: z.array(providerRow).max(1000) }).parse(JSON.parse(
    new TextDecoder().decode(await boundedPrivateBody(response.body, 524288)),
  ));
  const seen = new Set<string>();
  const numbers: z.infer<typeof numberSearchResponse>['numbers'] = [];
  for (const row of payload.data) {
    if (!/^\+1\d{10}$/.test(row.phone_number) || seen.has(row.phone_number) || !row.features?.some(feature => feature.name === 'voice')) continue;
    const regions = row.region_information ?? [];
    const country = regions.find(region => region.region_type === 'country_code')?.region_name;
    if (country && country.toUpperCase() !== search.country) continue;
    const exactMatch = row.best_effort !== true && matchesNumberPattern(row.phone_number, search, digits);
    if (!exactMatch && search.includeSimilar !== 'true') continue;
    const raw = row.cost_information as Record<string, unknown> | undefined;
    const parsedCost = costSchema.safeParse(raw && {
      monthly: raw.monthly_cost ?? null, upfront: raw.upfront_cost ?? null, currency: raw.currency,
    });
    seen.add(row.phone_number);
    numbers.push({ phoneNumber: row.phone_number, exactMatch,
      location: [...new Set(regions.filter(region => ['location', 'rate_center', 'state'].includes(region.region_type))
        .map(region => region.region_name))].join(', '),
      cost: parsedCost.success ? parsedCost.data : null,
    });
  }
  numbers.sort((a, b) => Number(b.exactMatch) - Number(a.exactMatch) || a.phoneNumber.localeCompare(b.phoneNumber));
  return { search: { ...search, digits }, numbers: numbers.slice(0, search.limit) };
}

class NumberSearchError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function handleVoiceNumberSearch(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return authJson({ error: 'method_not_allowed' }, 405, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return authJson({ error: 'invalid_number_search' }, 400, cors);
    const input = numberSearchInput.safeParse(Object.fromEntries(params));
    if (!input.success) return authJson({ error: 'invalid_number_search' }, 400, cors);
    const digits = numberSearchDigits(input.data.query);
    if (digits.length > (input.data.areaCode ? 7 : 10) || (input.data.query && !digits)) return authJson({ error: 'invalid_number_search' }, 400, cors);
    if (!env.TELNYX_API_KEY || !env.VOICE_NUMBER_SEARCH_LIMIT) return authJson({ error: 'number_search_unavailable' }, 503, cors);
    if (!(await env.VOICE_NUMBER_SEARCH_LIMIT.limit({ key: `voice-numbers:${user.id}` })).success)
      return authJson({ error: 'number_search_rate_limited' }, 429, { ...cors, 'retry-after': '60' });
    return authJson(await searchVoiceNumbers(env, input.data), 200, cors);
  } catch (error) {
    if (error instanceof NumberSearchError) return authJson({ error: error.message }, error.status, cors);
    console.error('voice_number_search_unavailable');
    return authJson({ error: 'number_search_unavailable' }, 503, cors);
  }
}
