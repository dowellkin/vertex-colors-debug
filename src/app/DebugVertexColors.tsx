import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
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
/** Как трактовать значения COLOR_n: linear — как есть (glTF-спека и Three.js), srgb — декодировать sRGB → linear. */
type ColorDecodeMode = 'linear' | 'srgb'
type ColorAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute

const VERTEX_BLEND_MODE_ID: Record<VertexBlendMode, number> = {
	multiply: 0,
	add: 1,
	screen: 2,
	overlay: 3,
	mix: 4,
}

const COLOR_DECODE_ID: Record<ColorDecodeMode, number> = {
	linear: 0,
	srgb: 1,
}

/** Клик дальше этого сдвига (px) от pointerdown — это вращение орбиты, а не пик. */
const CLICK_MAX_DRAG_PX = 4

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
	colorDecode: ColorDecodeMode
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
	/** Ключ — glTF-имя (COLOR_n). Ссылки на исходные атрибуты: `color` в геометрии перезаписывается при переключении слоя. */
	colorAttrs: Record<string, { attr: ColorAttribute; threeName: string }>
}

interface PickedColorAttr {
	gltfName: string
	threeName: string
	arrayType: string
	normalized: boolean
	itemSize: number
	/** [угол треугольника][компонента] — как лежит в буфере (для Uint8/Uint16 — целые). */
	raw: number[][]
	/** [угол треугольника][компонента] — после нормализации, то, что получает шейдер до sRGB-декода. */
	values: number[][]
}

interface VertexPick {
	meshName: string
	faceIndex: number
	vertexIndices: [number, number, number]
	bary: [number, number, number]
	nearestCorner: number
	hitPoint: THREE.Vector3
	/** Мировые позиции углов треугольника. */
	cornerPoints: THREE.Vector3[]
	attrs: PickedColorAttr[]
}

const DEFAULT_SETTINGS: Settings = {
	materialMode: 'basic',
	vertexColorsOn: true,
	colorAttribute: 'COLOR_0',
	textureOn: false,
	vertexBlend: 'multiply',
	vertexBlendFactor: 0.5,
	colorDecode: 'linear',
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
	material.userData.vertexColorDecode = COLOR_DECODE_ID.linear
	material.customProgramCacheKey = () => 'debug-vertex-blend-v2'
	material.onBeforeCompile = (shader) => {
		shader.uniforms.vertexBlendMode = { value: material.userData.vertexBlendMode }
		shader.uniforms.vertexBlendFactor = { value: material.userData.vertexBlendFactor }
		shader.uniforms.vertexColorDecode = { value: material.userData.vertexColorDecode }
		material.userData.shader = shader
		// sRGB-декод по вершинам, до интерполяции — эквивалентно тому, как если бы экспортёр сконвертировал данные в linear.
		shader.vertexShader = shader.vertexShader
			.replace(
				'#include <common>',
				`#include <common>
uniform int vertexColorDecode;
`,
			)
			.replace(
				'#include <color_vertex>',
				`#include <color_vertex>
#if defined( USE_COLOR )
	if (vertexColorDecode == 1) {
		vec3 c = max(vColor.rgb, vec3(0.0));
		vColor.rgb = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
	}
#endif
`,
			)
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

function applyVertexBlend(material: BlendableMaterial, mode: VertexBlendMode, factor: number, decode: ColorDecodeMode) {
	const modeId = VERTEX_BLEND_MODE_ID[mode]
	const decodeId = COLOR_DECODE_ID[decode]
	material.userData.vertexBlendMode = modeId
	material.userData.vertexBlendFactor = factor
	material.userData.vertexColorDecode = decodeId
	const shader = material.userData.shader as {
		uniforms: {
			vertexBlendMode: { value: number }
			vertexBlendFactor: { value: number }
			vertexColorDecode: { value: number }
		}
	} | undefined
	if (!shader) return
	shader.uniforms.vertexBlendMode.value = modeId
	shader.uniforms.vertexBlendFactor.value = factor
	shader.uniforms.vertexColorDecode.value = decodeId
}

function collectColorAttrs(geometry: THREE.BufferGeometry): Record<string, { attr: ColorAttribute; threeName: string }> {
	const attrs: Record<string, { attr: ColorAttribute; threeName: string }> = {}
	for (const threeName of Object.keys(geometry.attributes)) {
		const parsed = parseColorAttrName(threeName)
		if (!parsed) continue
		attrs[parsed.gltfName] = {
			attr: geometry.attributes[threeName],
			threeName,
		}
	}
	return attrs
}

const compareGltfNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

/** Та же формула, что в вершинном шейдере. */
function srgbToLinear(c: number): number {
	const x = Math.max(c, 0)
	return x < 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c: number): number {
	const x = Math.max(c, 0)
	return x < 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
}

const COMPONENT_GETTERS = ['getX', 'getY', 'getZ', 'getW'] as const

/** Значение как его видит шейдер (normalized-атрибуты уже приведены к 0..1). */
function readComponent(attr: ColorAttribute, index: number, component: number): number {
	return attr[COMPONENT_GETTERS[component]](index)
}

/** Значение как лежит в буфере, без нормализации. Учитывает interleaved-буферы (meshopt / gltf-transform). */
function readRawComponent(attr: ColorAttribute, index: number, component: number): number {
	if ('isInterleavedBufferAttribute' in attr && attr.isInterleavedBufferAttribute) {
		return attr.data.array[index * attr.data.stride + attr.offset + component]
	}
	return attr.array[index * attr.itemSize + component]
}

function describeArrayType(attr: ColorAttribute): string {
	const array = 'isInterleavedBufferAttribute' in attr && attr.isInterleavedBufferAttribute ? attr.data.array : attr.array
	return array.constructor.name.replace(/Array$/, '')
}

function buildVertexPick(mesh: Mesh, entry: MeshEntry, face: THREE.Face, faceIndex: number, point: THREE.Vector3): VertexPick {
	const vertexIndices: [number, number, number] = [face.a, face.b, face.c]
	const cornerLocal = vertexIndices.map((i) => mesh.getVertexPosition(i, new THREE.Vector3()))
	const localPoint = mesh.worldToLocal(point.clone())
	const baryVec = THREE.Triangle.getBarycoord(localPoint, cornerLocal[0], cornerLocal[1], cornerLocal[2], new THREE.Vector3())
	const bary: [number, number, number] = baryVec ? [baryVec.x, baryVec.y, baryVec.z] : [1 / 3, 1 / 3, 1 / 3]
	const nearestCorner = bary.indexOf(Math.max(...bary))

	const attrs = Object.entries(entry.colorAttrs)
		.sort(([a], [b]) => compareGltfNames(a, b))
		.map(([gltfName, { attr, threeName }]): PickedColorAttr => {
			const components = [...Array(Math.min(attr.itemSize, 4)).keys()]
			return {
				gltfName,
				threeName,
				arrayType: describeArrayType(attr),
				normalized: attr.normalized,
				itemSize: attr.itemSize,
				raw: vertexIndices.map((i) => components.map((c) => readRawComponent(attr, i, c))),
				values: vertexIndices.map((i) => components.map((c) => readComponent(attr, i, c))),
			}
		})

	return {
		meshName: mesh.name || '(без имени)',
		faceIndex,
		vertexIndices,
		bary,
		nearestCorner,
		hitPoint: point.clone(),
		cornerPoints: cornerLocal.map((v) => v.clone().applyMatrix4(mesh.matrixWorld)),
		attrs,
	}
}

/** Подменяет материалы на лету обходом сцены; исходный map сохраняется в MeshEntry для отключения текстуры. */
function VertexColorModel({ modelUrl, settings, onStats, onPick }: {
	modelUrl: string
	settings: Settings
	onStats: (stats: SceneStats) => void
	onPick: (pick: VertexPick) => void
}) {
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

			const colorAttrs = collectColorAttrs(geometry)
			for (const [gltfName, { threeName }] of Object.entries(colorAttrs)) {
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
				.sort(([a], [b]) => compareGltfNames(a, b))
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
			const source = entry.colorAttrs[settings.colorAttribute]?.attr
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
			applyVertexBlend(material, settings.vertexBlend, settings.vertexBlendFactor, settings.colorDecode)
			mesh.material = material
		}
	}, [clonedScene, settings.materialMode, settings.vertexColorsOn, settings.colorAttribute, settings.textureOn, settings.vertexBlend, settings.vertexBlendFactor, settings.colorDecode, settings.wireframe])

	const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
		if (e.delta > CLICK_MAX_DRAG_PX) return
		const mesh = e.object as Mesh
		const entry = entriesRef.current.get(mesh)
		if (!mesh.isMesh || !entry || !e.face) return
		// Только ближайшее пересечение, остальные меши за ним не интересны.
		e.stopPropagation()
		onPick(buildVertexPick(mesh, entry, e.face, e.faceIndex ?? -1, e.point))
	}, [onPick])

	// Без масштабов и трансформов — это просто вьюер. dispose={null}: геометрии общие с кэшем useGLTF.
	return <primitive object={clonedScene} dispose={null} onClick={handleClick} />
}

const markerMaterialProps = { depthTest: false, transparent: true, toneMapped: false } as const

/** Треугольник под курсором, выбранная вершина и точка попадания — поверх сцены, без depth test. */
function PickMarkers({ pick, corner }: { pick: VertexPick; corner: number }) {
	const triangle = useMemo(() => new THREE.BufferGeometry().setFromPoints(pick.cornerPoints), [pick])
	const hit = useMemo(() => new THREE.BufferGeometry().setFromPoints([pick.hitPoint]), [pick])
	const vertex = useMemo(() => new THREE.BufferGeometry().setFromPoints([pick.cornerPoints[corner]]), [pick, corner])

	useEffect(() => () => triangle.dispose(), [triangle])
	useEffect(() => () => hit.dispose(), [hit])
	useEffect(() => () => vertex.dispose(), [vertex])

	return (
		<>
			<lineLoop geometry={triangle} renderOrder={1000}>
				<lineBasicMaterial color="#ffd400" {...markerMaterialProps} />
			</lineLoop>
			<points geometry={hit} renderOrder={1001}>
				<pointsMaterial color="#ffffff" size={6} sizeAttenuation={false} {...markerMaterialProps} />
			</points>
			<points geometry={vertex} renderOrder={1002}>
				<pointsMaterial color="#ff2bd6" size={12} sizeAttenuation={false} {...markerMaterialProps} />
			</points>
		</>
	)
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

const inspectorStyle: CSSProperties = {
	...overlayStyle,
	left: 'auto',
	right: 12,
	width: 360,
}

const valueGridStyle: CSSProperties = {
	display: 'grid',
	gridTemplateColumns: '72px repeat(4, 1fr)',
	columnGap: 6,
	fontVariantNumeric: 'tabular-nums',
}

const swatchStyle: CSSProperties = {
	width: 36,
	height: 18,
	borderRadius: 3,
	border: '1px solid rgba(255,255,255,0.3)',
	flexShrink: 0,
}

const COMPONENT_LABELS = ['R', 'G', 'B', 'A']

function toCssColor(rgb: number[]): string {
	const channel = (v: number) => Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255)
	return `rgb(${channel(rgb[0] ?? 0)}, ${channel(rgb[1] ?? 0)}, ${channel(rgb[2] ?? 0)})`
}

function toHex(rgb: number[]): string {
	return '#' + rgb.slice(0, 3)
		.map((v) => Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255).toString(16).padStart(2, '0'))
		.join('')
}

/** sRGB-декод только для RGB, альфа всегда линейная. */
function decodeRgb(values: number[]): number[] {
	return values.map((v, i) => (i < 3 ? srgbToLinear(v) : v))
}

function ValueRow({ label, values, format, highlight }: {
	label: string
	values: number[]
	format: (v: number) => string
	highlight?: boolean
}) {
	return (
		<div style={{ ...valueGridStyle, color: highlight ? '#ffd400' : undefined }}>
			<span style={{ opacity: highlight ? 1 : 0.6 }}>{label}</span>
			{values.map((v, i) => <span key={i}>{format(v)}</span>)}
		</div>
	)
}

function PickedAttrBlock({ attr, corner, bary, decode, isActive }: {
	attr: PickedColorAttr
	corner: number
	bary: [number, number, number]
	decode: ColorDecodeMode
	isActive: boolean
}) {
	const isFloat = attr.arrayType.startsWith('Float')
	const stored = attr.values[corner]
	const decoded = decodeRgb(stored)
	const toShader = (values: number[]) => (decode === 'srgb' ? decodeRgb(values) : values)
	// GPU интерполирует уже декодированный vColor, поэтому сначала декод по углам, потом барицентрика.
	const shaderAtHit = stored.map((_, c) => attr.values.reduce((sum, cornerValues, k) => sum + toShader(cornerValues)[c] * bary[k], 0))
	const fmt = (v: number) => v.toFixed(3)

	return (
		<fieldset style={{ ...fieldsetStyle, borderColor: isActive ? 'rgba(255,212,0,0.6)' : undefined }}>
			<legend>
				{attr.gltfName}
				<span style={{ opacity: 0.55 }}> · {attr.threeName} · {attr.arrayType}{attr.normalized ? ' norm' : ''} · {attr.itemSize === 4 ? 'RGBA' : 'RGB'}</span>
			</legend>
			<div style={valueGridStyle}>
				<span />
				{stored.map((_, i) => <span key={i} style={{ opacity: 0.6 }}>{COMPONENT_LABELS[i]}</span>)}
			</div>
			{!isFloat && <ValueRow label="raw" values={attr.raw[corner]} format={String} />}
			<ValueRow label={decode === 'linear' ? 'float ◀' : 'float'} values={stored} format={fmt} highlight={decode === 'linear'} />
			<ValueRow label={decode === 'srgb' ? 'sRGB→lin ◀' : 'sRGB→lin'} values={decoded} format={fmt} highlight={decode === 'srgb'} />
			<ValueRow label="в точке" values={shaderAtHit} format={fmt} />
			<div style={{ ...rowStyle, marginTop: 4 }}>
				<div style={{ ...swatchStyle, background: toCssColor(stored), outline: decode === 'srgb' ? '2px solid #ffd400' : undefined }} />
				<span style={{ opacity: decode === 'srgb' ? 1 : 0.6 }}>как sRGB {toHex(stored)}</span>
			</div>
			<div style={rowStyle}>
				<div style={{ ...swatchStyle, background: toCssColor(stored.map((v, i) => (i < 3 ? linearToSrgb(v) : v))), outline: decode === 'linear' ? '2px solid #ffd400' : undefined }} />
				<span style={{ opacity: decode === 'linear' ? 1 : 0.6 }}>как linear</span>
			</div>
		</fieldset>
	)
}

function VertexInspector({ pick, corner, onCornerChange, decode, activeAttribute, onClose }: {
	pick: VertexPick
	corner: number
	onCornerChange: (corner: number) => void
	decode: ColorDecodeMode
	activeAttribute: string
	onClose: () => void
}) {
	const p = pick.hitPoint
	return (
		<div style={inspectorStyle}>
			<div style={{ ...rowStyle, justifyContent: 'space-between' }}>
				<span style={{ fontWeight: 700, fontSize: 13 }}>Инспектор вершины</span>
				<button type="button" style={buttonStyle} onClick={onClose}>✕</button>
			</div>
			<div style={{ wordBreak: 'break-all' }}>
				<div>mesh: {pick.meshName}</div>
				<div>face #{pick.faceIndex} · hit ({p.x.toFixed(3)}, {p.y.toFixed(3)}, {p.z.toFixed(3)})</div>
			</div>
			<fieldset style={fieldsetStyle}>
				<legend>Вершина треугольника (bary)</legend>
				{pick.vertexIndices.map((vertexIndex, k) => (
					<label key={k} style={rowStyle}>
						<input type="radio" name="pickCorner" checked={corner === k} onChange={() => onCornerChange(k)} />
						#{vertexIndex}
						<span style={{ opacity: 0.55 }}> · w={pick.bary[k].toFixed(3)}{k === pick.nearestCorner ? ' · ближайшая' : ''}</span>
					</label>
				))}
			</fieldset>
			{pick.attrs.length > 0 ? (
				pick.attrs.map((attr) => (
					<PickedAttrBlock
						key={attr.gltfName}
						attr={attr}
						corner={corner}
						bary={pick.bary}
						decode={decode}
						isActive={attr.gltfName === activeAttribute}
					/>
				))
			) : (
				<div style={{ opacity: 0.55 }}>у меша нет COLOR_*</div>
			)}
			<div style={{ opacity: 0.55 }}>
				◀ — что уходит в шейдер при текущем декоде. «в точке» — барицентрическая интерполяция в точке клика (после декода).
			</div>
		</div>
	)
}

export default function DebugVertexColors() {
	const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
	const [stats, setStats] = useState<SceneStats | null>(null)
	const [modelUrl, setModelUrl] = useState(MODEL_PATH)
	const [localFileName, setLocalFileName] = useState<string | null>(null)
	const [pick, setPick] = useState<VertexPick | null>(null)
	const [pickCorner, setPickCorner] = useState(0)
	const objectUrlRef = useRef<string | null>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)

	const handlePick = useCallback((p: VertexPick) => {
		setPick(p)
		setPickCorner(p.nearestCorner)
	}, [])

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
		setPick(null)
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
		setPick(null)
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

				<fieldset style={fieldsetStyle}>
					<legend>Декодирование атрибута</legend>
					<label style={rowStyle}>
						<input
							type="radio"
							name="colorDecode"
							checked={settings.colorDecode === 'linear'}
							onChange={() => update('colorDecode', 'linear')}
							disabled={!settings.vertexColorsOn}
						/>
						Linear — как есть (glTF / Three.js)
					</label>
					<label style={rowStyle}>
						<input
							type="radio"
							name="colorDecode"
							checked={settings.colorDecode === 'srgb'}
							onChange={() => update('colorDecode', 'srgb')}
							disabled={!settings.vertexColorsOn}
						/>
						sRGB → linear
					</label>
					<span style={{ opacity: 0.55 }}>
						По спеке glTF COLOR_n — linear. Если с sRGB стало «как в Blender/Substance» — цвета запечены в sRGB без конвертации при экспорте: проблема пайплайна, не модели.
					</span>
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
					<div style={{ opacity: 0.55, marginTop: 4 }}>Клик по модели → инспектор вершины</div>
				</div>
			</div>

			{pick && (
				<VertexInspector
					pick={pick}
					corner={pickCorner}
					onCornerChange={setPickCorner}
					decode={settings.colorDecode}
					activeAttribute={settings.colorAttribute}
					onClose={() => setPick(null)}
				/>
			)}

			{!stats && <LoadingFallback />}

			<Canvas camera={{ position: [8, 6, 8], fov: 50 }} dpr={[1, 1.5]} gl={{ antialias: true }} style={{ cursor: 'crosshair' }}>
				<RendererSettings
					toneMapping={settings.toneMapping}
					exposure={settings.exposure}
					background={settings.background}
				/>
				{settings.materialMode === 'standard' && <ambientLight intensity={0.3} />}
				<Suspense fallback={null}>
					<VertexColorModel key={modelUrl} modelUrl={modelUrl} settings={settings} onStats={handleStats} onPick={handlePick} />
				</Suspense>
				{pick && <PickMarkers pick={pick} corner={pickCorner} />}
				<OrbitControls makeDefault />
			</Canvas>
		</div>
	)
}

useGLTF.preload(MODEL_PATH)
