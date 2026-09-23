import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { Mesh } from 'three'
import { assetUrl } from '@utils/assetPath'

/** Тестовая модель с вершинными цветами, запечёнными художницей. */
const MODEL_PATH = assetUrl('/3d-models-min/3dobjects/level_2/central_plaza_test_compressed.glb')

type MaterialMode = 'basic' | 'standard'
type ToneMappingMode = 'none' | 'aces' | 'agx'
type BackgroundMode = 'black' | 'grey' | 'white'
type VertexBlendMode = 'multiply' | 'add' | 'screen' | 'overlay' | 'mix'

const VERTEX_BLEND_MODE_ID: Record<VertexBlendMode, number> = {
	multiply: 0,
	add: 1,
	screen: 2,
	overlay: 3,
	mix: 4,
}

const TONE_MAPPING_MAP: Record<ToneMappingMode, THREE.ToneMapping> = {
	none: THREE.NoToneMapping,
	aces: THREE.ACESFilmicToneMapping,
	agx: THREE.AgXToneMapping,
}

const BACKGROUND_MAP: Record<BackgroundMode, string> = {
	black: '#000000',
	grey: '#808080',
	white: '#ffffff',
}

interface Settings {
	materialMode: MaterialMode
	vertexColorsOn: boolean
	colorAttribute: string
	textureOn: boolean
	vertexBlend: VertexBlendMode
	vertexBlendFactor: number
	toneMapping: ToneMappingMode
	exposure: number
	background: BackgroundMode
	wireframe: boolean
}

interface ColorAttributeInfo {
	gltfName: string
	threeName: string
	meshCount: number
}

interface SceneStats {
	meshCount: number
	triangleCount: number
	colorAttributes: ColorAttributeInfo[]
}

interface MeshEntry {
	basic: THREE.MeshBasicMaterial
	standard: THREE.MeshStandardMaterial
	originalMap: THREE.Texture | null
	colorAttrs: Record<string, THREE.BufferAttribute>
}

const DEFAULT_SETTINGS: Settings = {
	materialMode: 'basic',
	vertexColorsOn: true,
	colorAttribute: 'COLOR_0',
	textureOn: false,
	vertexBlend: 'multiply',
	vertexBlendFactor: 0.5,
	toneMapping: 'none',
	exposure: 1,
	background: 'grey',
	wireframe: false,
}

/**
 * GLTFLoader мапит только COLOR_0 → `color`.
 * Остальные слои остаются как `color_1`, `color_2` (toLowerCase исходного имени).
 */
function parseColorAttrName(threeName: string): { gltfName: string; threeName: string } | null {
	if (threeName === 'color') return { gltfName: 'COLOR_0', threeName }
	const match = /^color_?(\d+)$/i.exec(threeName)
	return match ? { gltfName: `COLOR_${match[1]}`, threeName } : null
}

type BlendableMaterial = THREE.MeshBasicMaterial | THREE.MeshStandardMaterial

function attachVertexBlend(material: BlendableMaterial) {
	material.userData.vertexBlendMode = VERTEX_BLEND_MODE_ID.multiply
	material.userData.vertexBlendFactor = 0.5
	material.customProgramCacheKey = () => 'debug-vertex-blend-v1'
	material.onBeforeCompile = (shader) => {
		shader.uniforms.vertexBlendMode = { value: material.userData.vertexBlendMode }
		shader.uniforms.vertexBlendFactor = { value: material.userData.vertexBlendFactor }
		material.userData.shader = shader
		shader.fragmentShader = shader.fragmentShader
			.replace(
				'#include <color_pars_fragment>',
				`#include <color_pars_fragment>
uniform int vertexBlendMode;
uniform float vertexBlendFactor;

vec3 blendVertexRgb(vec3 base, vec3 blend) {
	if (vertexBlendMode == 1) return base + blend;
	if (vertexBlendMode == 2) return 1.0 - (1.0 - base) * (1.0 - blend);
	if (vertexBlendMode == 3) {
		return mix(
			2.0 * base * blend,
			1.0 - 2.0 * (1.0 - base) * (1.0 - blend),
			step(0.5, base)
		);
	}
	if (vertexBlendMode == 4) return mix(base, blend, vertexBlendFactor);
	return base * blend;
}
`,
			)
			.replace(
				'#include <color_fragment>',
				`#if defined( USE_COLOR_ALPHA )
	diffuseColor.rgb = blendVertexRgb(diffuseColor.rgb, vColor.rgb);
	diffuseColor.a *= vColor.a;
#elif defined( USE_COLOR )
	diffuseColor.rgb = blendVertexRgb(diffuseColor.rgb, vColor);
#endif
`,
			)
	}
}

function applyVertexBlend(material: BlendableMaterial, mode: VertexBlendMode, factor: number) {
	const modeId = VERTEX_BLEND_MODE_ID[mode]
	material.userData.vertexBlendMode = modeId
	material.userData.vertexBlendFactor = factor
	const shader = material.userData.shader as {
		uniforms: {
			vertexBlendMode: { value: number }
			vertexBlendFactor: { value: number }
		}
	} | undefined
	if (!shader) return
	shader.uniforms.vertexBlendMode.value = modeId
	shader.uniforms.vertexBlendFactor.value = factor
}

function collectColorAttrs(geometry: THREE.BufferGeometry): Record<string, { attr: THREE.BufferAttribute; threeName: string }> {
	const attrs: Record<string, { attr: THREE.BufferAttribute; threeName: string }> = {}
	for (const threeName of Object.keys(geometry.attributes)) {
		const parsed = parseColorAttrName(threeName)
		if (!parsed) continue
		attrs[parsed.gltfName] = {
			attr: geometry.attributes[threeName] as THREE.BufferAttribute,
			threeName,
		}
	}
	return attrs
}

/** Подменяет материалы на лету обходом сцены; исходный map сохраняется в MeshEntry для отключения текстуры. */
function VertexColorModel({ modelUrl, settings, onStats }: { modelUrl: string; settings: Settings; onStats: (stats: SceneStats) => void }) {
	const { scene } = useGLTF(modelUrl)
	const clonedScene = useMemo(() => {
		const clone = scene.clone(true)
		clone.traverse((obj) => {
			const mesh = obj as Mesh
			if (mesh.isMesh) mesh.geometry = mesh.geometry.clone()
		})
		return clone
	}, [scene])
	const entriesRef = useRef<Map<Mesh, MeshEntry>>(new Map())

	useEffect(() => {
		const entries = new Map<Mesh, MeshEntry>()
		let meshCount = 0
		let triangleCount = 0
		const attrMeshCounts = new Map<string, { threeName: string; meshCount: number }>()

		clonedScene.traverse((obj) => {
			const mesh = obj as Mesh
			if (!mesh.isMesh) return

			meshCount += 1

			const geometry = mesh.geometry
			const positionCount = geometry.attributes.position?.count ?? 0
			triangleCount += geometry.index ? geometry.index.count / 3 : positionCount / 3

			const collected = collectColorAttrs(geometry)
			const colorAttrs: Record<string, THREE.BufferAttribute> = {}
			for (const [gltfName, { attr, threeName }] of Object.entries(collected)) {
				colorAttrs[gltfName] = attr
				const prev = attrMeshCounts.get(gltfName)
				attrMeshCounts.set(gltfName, { threeName, meshCount: (prev?.meshCount ?? 0) + 1 })
			}

			const originalMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
			const originalMap = (originalMaterial as THREE.MeshStandardMaterial | undefined)?.map ?? null
			const hasAnyColor = Object.keys(colorAttrs).length > 0
			const basic = new THREE.MeshBasicMaterial({ map: originalMap, vertexColors: hasAnyColor })
			const standard = new THREE.MeshStandardMaterial({ map: originalMap, vertexColors: hasAnyColor })
			attachVertexBlend(basic)
			attachVertexBlend(standard)

			entries.set(mesh, {
				basic,
				standard,
				originalMap,
				colorAttrs,
			})
		})

		entriesRef.current = entries
		onStats({
			meshCount,
			triangleCount: Math.round(triangleCount),
			colorAttributes: [...attrMeshCounts.entries()]
				.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
				.map(([gltfName, info]) => ({ gltfName, threeName: info.threeName, meshCount: info.meshCount })),
		})

		return () => {
			for (const entry of entries.values()) {
				entry.basic.dispose()
				entry.standard.dispose()
			}
		}
	}, [clonedScene, onStats])

	useEffect(() => {
		for (const [mesh, entry] of entriesRef.current) {
			const source = entry.colorAttrs[settings.colorAttribute]
			if (source) mesh.geometry.setAttribute('color', source)

			const material = settings.materialMode === 'basic' ? entry.basic : entry.standard
			const vertexColors = settings.vertexColorsOn && !!source
			const map = settings.textureOn ? entry.originalMap : null
			if (material.vertexColors !== vertexColors || material.map !== map || material.wireframe !== settings.wireframe) {
				material.vertexColors = vertexColors
				material.map = map
				material.wireframe = settings.wireframe
				material.needsUpdate = true
			}
			applyVertexBlend(material, settings.vertexBlend, settings.vertexBlendFactor)
			mesh.material = material
		}
	}, [clonedScene, settings.materialMode, settings.vertexColorsOn, settings.colorAttribute, settings.textureOn, settings.vertexBlend, settings.vertexBlendFactor, settings.wireframe])

	// Без масштабов и трансформов — это просто вьюер. dispose={null}: геометрии общие с кэшем useGLTF.
	return <primitive object={clonedScene} dispose={null} />
}

function RendererSettings({ toneMapping, exposure, background }: {
	toneMapping: ToneMappingMode
	exposure: number
	background: BackgroundMode
}) {
	const { gl, scene } = useThree()

	useEffect(() => {
		gl.toneMapping = TONE_MAPPING_MAP[toneMapping]
		gl.toneMappingExposure = exposure
	}, [gl, toneMapping, exposure])

	useEffect(() => {
		scene.background = new THREE.Color(BACKGROUND_MAP[background])
	}, [scene, background])

	return null
}

const overlayStyle: CSSProperties = {
	position: 'fixed',
	top: 12,
	left: 12,
	zIndex: 10,
	padding: '12px 14px',
	background: 'rgba(20, 20, 24, 0.85)',
	color: '#eee',
	fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
	fontSize: 12,
	lineHeight: 1.5,
	borderRadius: 8,
	display: 'flex',
	flexDirection: 'column',
	gap: 8,
	width: 280,
	maxHeight: 'calc(100vh - 24px)',
	overflowY: 'auto',
}

const fieldsetStyle: CSSProperties = {
	border: '1px solid rgba(255,255,255,0.15)',
	borderRadius: 6,
	padding: '6px 8px',
	display: 'flex',
	flexDirection: 'column',
	gap: 4,
}

const rowStyle: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	gap: 6,
}

const buttonStyle: CSSProperties = {
	appearance: 'none',
	border: '1px solid rgba(255,255,255,0.25)',
	background: 'rgba(255,255,255,0.08)',
	color: '#eee',
	font: 'inherit',
	padding: '5px 8px',
	borderRadius: 4,
	cursor: 'pointer',
	textAlign: 'left',
}

const loadingFallbackStyle: CSSProperties = {
	position: 'fixed',
	inset: 0,
	zIndex: 1,
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	color: '#eee',
	background: '#111',
	fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
	fontSize: 14,
	pointerEvents: 'none',
}

function LoadingFallback() {
	return <div style={loadingFallbackStyle}>Загрузка модели…</div>
}

export default function DebugVertexColors() {
	const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
	const [stats, setStats] = useState<SceneStats | null>(null)
	const [modelUrl, setModelUrl] = useState(MODEL_PATH)
	const [localFileName, setLocalFileName] = useState<string | null>(null)
	const objectUrlRef = useRef<string | null>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)

	const handleStats = useCallback((s: SceneStats) => {
		setStats(s)
		setSettings((prev) => {
			if (s.colorAttributes.some((attr) => attr.gltfName === prev.colorAttribute)) return prev
			return { ...prev, colorAttribute: s.colorAttributes[0]?.gltfName ?? 'COLOR_0' }
		})
	}, [])

	const loadLocalFile = (file: File | undefined) => {
		if (!file) return
		if (objectUrlRef.current) {
			URL.revokeObjectURL(objectUrlRef.current)
			useGLTF.clear(objectUrlRef.current)
		}
		const url = URL.createObjectURL(file)
		objectUrlRef.current = url
		setModelUrl(url)
		setLocalFileName(file.name)
		setStats(null)
		setSettings((prev) => ({ ...prev, colorAttribute: 'COLOR_0' }))
	}

	const resetToDefaultModel = () => {
		if (objectUrlRef.current) {
			URL.revokeObjectURL(objectUrlRef.current)
			useGLTF.clear(objectUrlRef.current)
			objectUrlRef.current = null
		}
		setModelUrl(MODEL_PATH)
		setLocalFileName(null)
		setStats(null)
		setSettings((prev) => ({ ...prev, colorAttribute: 'COLOR_0' }))
		if (fileInputRef.current) fileInputRef.current.value = ''
	}

	useEffect(() => () => {
		if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
	}, [])

	const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
		setSettings((prev) => ({ ...prev, [key]: value }))

	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<div style={overlayStyle}>
				<div style={{ fontWeight: 700, fontSize: 13 }}>Vertex Colors Debug</div>

				<fieldset style={fieldsetStyle}>
					<legend>Модель</legend>
					<input
						ref={fileInputRef}
						type="file"
						accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
						style={{ display: 'none' }}
						onChange={(e) => loadLocalFile(e.target.files?.[0])}
					/>
					<button type="button" style={buttonStyle} onClick={() => fileInputRef.current?.click()}>
						Загрузить локальный файл…
					</button>
					<div style={{ opacity: 0.65, wordBreak: 'break-all' }}>
						{localFileName ?? 'по умолчанию: central_plaza_test_compressed.glb'}
					</div>
					{localFileName && (
						<button type="button" style={buttonStyle} onClick={resetToDefaultModel}>
							Сбросить к дефолтной
						</button>
					)}
				</fieldset>

				<fieldset style={fieldsetStyle}>
					<legend>Материал</legend>
					<label style={rowStyle}>
						<input
							type="radio"
							name="material"
							checked={settings.materialMode === 'basic'}
							onChange={() => update('materialMode', 'basic')}
						/>
						MeshBasicMaterial (unlit)
					</label>
					<label style={rowStyle}>
						<input
							type="radio"
							name="material"
							checked={settings.materialMode === 'standard'}
							onChange={() => update('materialMode', 'standard')}
						/>
						MeshStandardMaterial
					</label>
				</fieldset>

				<label style={rowStyle}>
					<input
						type="checkbox"
						checked={settings.vertexColorsOn}
						onChange={(e) => update('vertexColorsOn', e.target.checked)}
					/>
					vertexColors
				</label>

				<fieldset style={fieldsetStyle}>
					<legend>Атрибут цвета</legend>
					{stats && stats.colorAttributes.length > 0 ? (
						stats.colorAttributes.map((attr) => (
							<label key={attr.gltfName} style={rowStyle}>
								<input
									type="radio"
									name="colorAttr"
									checked={settings.colorAttribute === attr.gltfName}
									onChange={() => update('colorAttribute', attr.gltfName)}
								/>
								{attr.gltfName}
								<span style={{ opacity: 0.55 }}> · {attr.threeName} · {attr.meshCount}</span>
							</label>
						))
					) : (
						<div style={{ opacity: 0.55 }}>нет COLOR_*</div>
					)}
				</fieldset>

				<label style={rowStyle}>
					<input
						type="checkbox"
						checked={settings.textureOn}
						onChange={(e) => update('textureOn', e.target.checked)}
					/>
					Базовая текстура (material.map)
				</label>

				<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
					Наложение атрибута
					<select
						value={settings.vertexBlend}
						onChange={(e) => update('vertexBlend', e.target.value as VertexBlendMode)}
						disabled={!settings.vertexColorsOn}
					>
						<option value="multiply">multiply — glTF / Three.js</option>
						<option value="add">add</option>
						<option value="screen">screen</option>
						<option value="overlay">overlay</option>
						<option value="mix">mix (lerp)</option>
					</select>
				</label>

				{settings.vertexBlend === 'mix' && (
					<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
						mix: {settings.vertexBlendFactor.toFixed(2)}
						<input
							type="range"
							min={0}
							max={1}
							step={0.01}
							value={settings.vertexBlendFactor}
							onChange={(e) => update('vertexBlendFactor', Number(e.target.value))}
							disabled={!settings.vertexColorsOn}
						/>
						<span style={{ opacity: 0.55 }}>0 = текстура, 1 = атрибут</span>
					</label>
				)}

				<label style={rowStyle}>
					<input
						type="checkbox"
						checked={settings.wireframe}
						onChange={(e) => update('wireframe', e.target.checked)}
					/>
					Wireframe
				</label>

				<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
					Tone mapping
					<select
						value={settings.toneMapping}
						onChange={(e) => update('toneMapping', e.target.value as ToneMappingMode)}
					>
						<option value="none">None</option>
						<option value="aces">ACESFilmic</option>
						<option value="agx">AgX</option>
					</select>
				</label>

				<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
					Exposure: {settings.exposure.toFixed(2)}
					<input
						type="range"
						min={0.1}
						max={3}
						step={0.05}
						value={settings.exposure}
						onChange={(e) => update('exposure', Number(e.target.value))}
					/>
				</label>

				<fieldset style={fieldsetStyle}>
					<legend>Фон</legend>
					<label style={rowStyle}>
						<input
							type="radio"
							name="bg"
							checked={settings.background === 'black'}
							onChange={() => update('background', 'black')}
						/>
						чёрный
					</label>
					<label style={rowStyle}>
						<input
							type="radio"
							name="bg"
							checked={settings.background === 'grey'}
							onChange={() => update('background', 'grey')}
						/>
						серый
					</label>
					<label style={rowStyle}>
						<input
							type="radio"
							name="bg"
							checked={settings.background === 'white'}
							onChange={() => update('background', 'white')}
						/>
						белый
					</label>
				</fieldset>

				<div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', paddingTop: 8, marginTop: 4 }}>
					{stats ? (
						<>
							<div>Мешей: {stats.meshCount}</div>
							<div>Треугольников: {stats.triangleCount.toLocaleString('ru-RU')}</div>
							{stats.colorAttributes.map((attr) => (
								<div key={attr.gltfName}>
									{attr.gltfName} ({attr.threeName}): {attr.meshCount}
								</div>
							))}
						</>
					) : (
						<div>Загрузка статистики…</div>
					)}
				</div>
			</div>

			{!stats && <LoadingFallback />}

			<Canvas camera={{ position: [8, 6, 8], fov: 50 }} dpr={[1, 1.5]} gl={{ antialias: true }}>
				<RendererSettings
					toneMapping={settings.toneMapping}
					exposure={settings.exposure}
					background={settings.background}
				/>
				{settings.materialMode === 'standard' && <ambientLight intensity={0.3} />}
				<Suspense fallback={null}>
					<VertexColorModel key={modelUrl} modelUrl={modelUrl} settings={settings} onStats={handleStats} />
				</Suspense>
				<OrbitControls makeDefault />
			</Canvas>
		</div>
	)
}

useGLTF.preload(MODEL_PATH)
