// This deliberately public demo is isolated from all other BFF projects.
export const demoConfig = {
  apiOrigin: 'https://api.mainbrella.com',
  projectId: '90da3093-84b6-4cd7-a39a-a8afc39403b8',
  publicKey: 'bff_pk_1f9bb9fd543d6a5476ad7ce210577c2479d290a5cdc06282de9eb884d57005c4',
  table: 'messages',
} as const;

// The local example has its own fixed project and browser key.
export const localDemoConfig = {
  apiOrigin: 'http://localhost:8787',
  projectId: '7a42a924-ef00-4d4b-9324-562ac791b55f',
  publicKey: 'bff_pk_26b04357a1ca6e08a50f29bef3daa2003c5ba1319cbc43d0474bc22948404072',
  table: 'messages',
} as const;

export const demoUsers = ['alice', 'bob'] as const;
export type DemoUser = typeof demoUsers[number];
