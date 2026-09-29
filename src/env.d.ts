interface ImportMetaEnv {
	/** magnet-seeders base URL (defaults to production). */
	readonly PUBLIC_SEEDERS_URL?: string;
	/** magnet-worker base URL (defaults to production). */
	readonly PUBLIC_WORKER_URL?: string;
}

/** When this build was made (set in astro.config.mjs); diagnostics report it. */
declare const __MW_BUILD__: string | undefined;
