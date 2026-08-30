// Client entry — mounts the React app and pulls in the global stylesheet.
import { createRoot } from 'react-dom/client'
import App from './App'
import '../style.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
