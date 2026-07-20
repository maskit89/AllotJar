// Thin wrapper over Google Identity Services (the accounts.google.com/gsi/client script).
// Kept as its own module so components can be unit-tested with a mock — the real script only
// loads in a browser with network access, and only when a client id is configured at build time.

/** The OAuth Web client id baked into the bundle, or '' ⇒ Google sign-in is off. */
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''

const GSI_SRC = 'https://accounts.google.com/gsi/client'

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (config: {
            client_id: string
            callback: (response: { credential: string }) => void
            // FedCM is the browser-mediated flow Google migrated GIS onto in 2025.
            use_fedcm_for_prompt?: boolean
          }) => void
          renderButton: (
            parent: HTMLElement,
            options: {
              type?: 'standard' | 'icon'
              theme?: 'outline' | 'filled_blue' | 'filled_black'
              size?: 'large' | 'medium' | 'small'
              text?: 'signin_with' | 'signup_with' | 'continue_with'
              shape?: 'rectangular' | 'pill'
              width?: number
              logo_alignment?: 'left' | 'center'
            },
          ) => void
        }
      }
    }
  }
}

let loader: Promise<void> | null = null

/** Loads the GSI script once (resolving immediately if it's already present). */
function loadGsiScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve()
  if (!loader) {
    loader = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = GSI_SRC
      script.async = true
      script.defer = true
      script.onload = () => resolve()
      script.onerror = () => {
        loader = null // allow a retry on the next call
        reject(new Error('Failed to load Google sign-in.'))
      }
      document.head.appendChild(script)
    })
  }
  return loader
}

/**
 * Renders the official Google button into `container` and invokes `onCredential` with the signed
 * ID token when the user completes sign-in. Resolves once the button is rendered; rejects if the
 * script can't load (offline, blocked) — the caller decides how quietly to degrade.
 */
export async function renderGoogleButton(
  container: HTMLElement,
  onCredential: (credential: string) => void,
  options?: { text?: 'signin_with' | 'signup_with' | 'continue_with'; width?: number },
): Promise<void> {
  if (!GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not configured.')
  await loadGsiScript()
  const id = window.google?.accounts?.id
  if (!id) throw new Error('Google sign-in is unavailable.')

  id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (response) => onCredential(response.credential),
    use_fedcm_for_prompt: true,
  })
  id.renderButton(container, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    shape: 'rectangular',
    text: options?.text ?? 'continue_with',
    width: options?.width,
    logo_alignment: 'center',
  })
}
