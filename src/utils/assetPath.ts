/**
 * Prepends Vite's base URL to a public asset path.
 *
 * Dev, page served by Vite (localhost:5174 or a tunnel like *.lhr.life):
 *   relative "/" so GLBs follow the same host as the page.
 * Dev, game embedded in Laravel on another origin:
 *   VITE_DEV_ORIGIN (http://localhost:5174) so assets still hit Vite.
 * Production: BASE_URL is "/assets/onboarding-game/" — served from Laravel.
 */
function resolveDevBase(): string {
	const configured = String(import.meta.env.VITE_DEV_ORIGIN ?? 'http://localhost:5174').replace(/\/$/, '')
	if (typeof window === 'undefined') return `${configured}/`

	const viteOrigin = (() => {
		try {
			return new URL(configured).origin
		} catch {
			return configured
		}
	})()

	const { origin, hostname, port } = window.location
	const onViteOrigin = origin === viteOrigin
	const onVitePort = port === (new URL(viteOrigin).port || '5174')
	const viaTunnel = hostname !== 'localhost' && hostname !== '127.0.0.1'

	if (onViteOrigin || onVitePort || viaTunnel) return '/'
	return `${configured}/`
}

const BASE = import.meta.env.DEV ? resolveDevBase() : import.meta.env.BASE_URL

const BASE_3D_MODELS_PATH = import.meta.env.VITE_BASE_3D_MODELS_PATH ?? '/3d-models-min/';
const BASE_3D_OBJECTS_PATH = import.meta.env.VITE_BASE_3D_OBJECTS_PATH ?? '/3dobjects/';
const BASE_ANIMATED_3D_OBJECTS_PATH = import.meta.env.VITE_BASE_ANIMATED_3D_OBJECTS_PATH ?? '/animated-3dobjects/';

export const MODEL_BASE = BASE_3D_MODELS_PATH + BASE_3D_OBJECTS_PATH;
export const ANIMATED_MODEL_BASE = BASE_3D_MODELS_PATH + BASE_ANIMATED_3D_OBJECTS_PATH;

export function assetUrl(path: string): string {
	const clean = path.startsWith('/') ? path.slice(1) : path;
	return `${BASE}${clean}`;
}
