/**
 * The image-drag-in plugin (`tui-image-attach`): when an image file is dragged
 * into the composer, the terminal emulator pastes that file's PATH as text
 * (there is no file-drag event a terminal app can receive). This plugin detects
 * that the pasted text is a local image path, reads the file, saves it through
 * the harness attachment store, and presents it as a `[Image: name]` chip on the
 * composer (see the conversation panel / submit). A pasted local
 * image path is detected, read, and saved through the attachment store.
 *
 * The conversation panel calls `tui.imageAttach.imagePathFor` on a paste; if it
 * returns a path, `attachLocalImage` reads + saves the image and sets the chip.
 * Submit (tui-runtime) reads `store.composerImage` and emits an image content
 * block beside the text.
 *
 * @module @yourname/qialike-app/image-attach
 */

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachApi, Store, TuiService } from './index.tsx'

/** Stable Cordis plugin name. */
export const name = 'tui-image-attach'

/** The `tui` service (for mounting the API) and the store (for the chip). */
export const inject = ['tui', 'tuiStore']

/** Extension → media type accepted by the attachment store (png/jpeg/webp/gif). */
const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']

/** The subset of the attachment store this plugin needs. */
type AttachmentStoreLike = {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]): Promise<readonly ImageRef[]>
}

export function apply(ctx: Context): void {
  const store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  const attachments = ctx.get('attachments') as AttachmentStoreLike | undefined

  /** Strip paste quoting/`file://` and return the path when it is a known image. */
  function imagePathFor(text: string): string | null {
    const trimmed = text.trim()
    if (trimmed === '') return null
    let p = trimmed.replace(/^['"]+|['"]+$/g, '')
    if (p.startsWith('file://')) {
      try { p = fileURLToPath(p) } catch { return null }
    }
    // A pasted http(s) URL is a web link, not a local image file to attach.
    if (/^(https?):\/\//i.test(p)) return null
    if (!(extname(p).toLowerCase() in IMAGE_EXT_MIME)) return null
    return p
  }

  /** Read the image, save it durably, and set the composer image chip. */
  async function attachLocalImage(path: string): Promise<ImageRef | undefined> {
    if (attachments === undefined) {
      store.append('status', 'image attachments unavailable', true)
      return undefined
    }
    const name = basename(path)
    const mediaType = IMAGE_EXT_MIME[extname(path).toLowerCase()] ?? 'image/png'
    try {
      const bytes = await readFile(path)
      const refs = await attachments.saveImages([{ data: bytes, mediaType, name }])
      const ref = refs[0]
      if (ref === undefined) return undefined
      store.setComposerImage({ ref, name, mediaType })
      return ref
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Every single-file build stubs `sharp` (a native addon that cannot be
      // embedded), and sharp is the decoder this store admits images with, so an
      // INVALID_IMAGE rejection here means "no native image support in this
      // build", not that the user's file is malformed. Say so.
      const hint = /unsupported or malformed image data/i.test(message)
        ? ' — this build has no native image support (sharp is stubbed), so image attachments are unavailable'
        : ''
      store.append('status', `attach image failed: ${message}${hint}`, true)
      return undefined
    }
  }

  const api: ImageAttachApi = {
    imagePathFor,
    attachLocalImage,
    clear: () => store.clearComposerImage(),
  }
  tui.imageAttach = api
}

