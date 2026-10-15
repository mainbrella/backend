import { z } from 'zod';
import { numberSearchInput, numberSearchResponse } from './voice-number-search';
import { cookieSecurity, errors, jsonResponse, register, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

export function registerVoiceNumberSearchRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/voice/numbers/search', {
    tags: ['Voice'], operationId: 'searchVoiceNumbers', summary: 'Search available US and Canadian voice numbers', security: cookieSecurity,
    description: 'Search-only Telnyx inventory access using the server API key. Letters map to the standard phone keypad. Patterns exclude the country code and, when areaCode is specified, search only the seven local digits. Queries support up to ten digits, or seven with an area code. Similar results are opt-in and clearly marked. Only voice-capable numbers are returned. Prices are provider estimates for number rental and upfront cost, without calling usage. No number is bought, held or reserved. Requires a signed-in account; limited to 20 searches per minute per account. Duplicate and unknown query parameters are rejected.',
    request: { query: numberSearchInput, headers: z.object({ Origin: z.string().optional() }) },
    responses: { 200: jsonResponse(numberSearchResponse), ...errors(400, 401, 403, 405, 429, 503) },
  }, handler);
}
