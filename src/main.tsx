import { StrictMode, Suspense, lazy, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const DEBUG_ROUTE = '/debug/vertex-colors'
const DebugVertexColors = lazy(() => import('./app/DebugVertexColors.tsx'))

function Root() {
	useEffect(() => {
		if (window.location.pathname !== DEBUG_ROUTE) {
			window.history.replaceState(null, '', DEBUG_ROUTE)
		}
	}, [])

	return (
		<Suspense fallback={null}>
			<DebugVertexColors />
		</Suspense>
	)
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<Root />
	</StrictMode>,
)
