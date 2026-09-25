/// <reference types="vite/client" />
declare module '*.css';

interface ImportMetaEnv {
  /** Entra app registration client ID. Not secret -- baked into the build. Unset: sign-in stays off locally. */
  readonly VITE_AAD_CLIENT_ID?: string;
  readonly VITE_AAD_TENANT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
