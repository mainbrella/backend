export function startBffLocal(options: { statePath: string }): Promise<{
  url: string;
  token: string;
  close(): Promise<void>;
}>;
