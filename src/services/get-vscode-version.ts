const FALLBACK_VERSION = '1.104.3'

export async function getVSCodeVersion(): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(
      'https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin',
      { signal: controller.signal }
    )

    const pkgbuild = await response.text()
    const match = pkgbuild.match(/pkgver=([0-9.]+)/)

    return match?.[1] ?? FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
  } finally {
    clearTimeout(timeout)
  }
}
