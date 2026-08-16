/**
 * The in-app workspace-directory browser (figma Harness 813-23126 family): a
 * 680×500 dialog (clamped to short/narrow viewports) whose header carries the
 * title, the current-path breadcrumb, and a click-to-edit path zone; below it
 * one full-width column of the listed level. A row click lists that folder
 * (enter, not preview). Away from the filesystem root the column leads with a
 * synthetic `..` row that lists the parent crumb. Navigations are quiet: the
 * previous view keeps rendering while a crumb jump, a `..`/`row` enter, or a
 * submitted path is scanned, then the target replaces the column in one swap.
 * "New folder" opens a nested create dialog targeting the listed level and
 * then enters the created folder. Open adopts the listed level. Pure consumer
 * of the injected browse calls — the owning flow decides what "Open" means
 * and owns the workspace-creation error surface. Hidden entries are
 * host-flagged and hidden by default; the footer's fixed-label "Show hidden
 * files" toggle (aria-pressed, check when on) reveals them (client-side
 * only). The path editor announces itself with a pencil glyph and a bar-wide
 * hover-lit outline, opens seeded with a trailing separator, and keeps the
 * column under the draft: the final segment prefix-filters the listed level
 * while that level is the one the draft's directory part names (a dot-led
 * prefix also reveals the hidden entries it names, and a prefix nobody
 * matches releases the filter), while any other directory part is scanned
 * after a short debounce and lands like any other navigation. Typing deeper
 * descends and erasing segments walks back up without leaving the editor.
 * The column the draft walked to stays put when the editor closes
 * (cancellation included): the crumbs name where the walk ended, and Open's
 * target follows them.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutline16, IconChevronRightOutline14, IconEditOutline16, IconFolderClose16,
  IconPlusOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import { DirectoryBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'
import css from './DirectoryBrowser.module.css'

/** Owner-supplied browser props: browse calls, pick semantics, and copy. */
export interface DirectoryBrowserProps {
  /** Dialog visibility (owner-local; closed unmounts nothing but resets on reopen). */
  open: boolean
  /** List one directory level (absent path = the Host home directory); the signal aborts a superseded scan on the wire. */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** Create one child directory under an existing parent. */
  createDirectory: (path: string, name: string) => Promise<string>
  /** The operator confirmed a directory (the listed level). */
  onOpen: (path: string) => void
  /** Close without picking (mask, Escape, Cancel). */
  onClose: () => void
  /** The owner's confirm is in flight: Open disables, the view freezes. */
  busy: boolean
  /** Localized copy. */
  t: Translate
}

/** Failure text: the Host business message when typed, else the throw's text. */
function failureText(error: unknown): string {
  if (error instanceof DirectoryBrowseError) return error.rpcError.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * How long a scan may stay visually silent before the floating "Loading…"
 * pill appears. The stale view keeps rendering while a scan is in flight, so
 * a listing that settles inside this window swaps the column with no
 * intermediate frame at all; only a genuinely slow host (a network mount, a
 * cold disk) surfaces the indicator.
 */
const SLOW_SCAN_DELAY_MS = 300

/**
 * How long a typed draft rests before the column follows it to a directory
 * the listed level does not name. The window absorbs the keystrokes that
 * walk through intermediate directory parts (every character of `/usr/lo`
 * past the separator would otherwise be its own scan) while staying short
 * enough that a pause reads as "the list moved with me".
 */
const DRAFT_PREVIEW_DEBOUNCE_MS = 250

/**
 * Breadcrumb rows for display: inside the home subtree the chain starts at a
 * localized Home crumb; outside it the full ancestry shows, the root labeled
 * by its own path.
 */
function displayCrumbs(listing: DirectoryListing, homeLabel: string): DirectoryEntry[] {
  const homeIndex = listing.crumbs.findIndex(crumb => crumb.path === listing.home)
  if (homeIndex === -1) return listing.crumbs
  const tail = listing.crumbs.slice(homeIndex + 1)
  return [{ name: homeLabel, path: listing.home, hidden: false }, ...tail]
}

/**
 * The listing's platform separator, inferred from the home path the host
 * stamped — never from typed text or entry paths, where a backslash is a
 * legal POSIX name character. Still a heuristic at the last step: a POSIX
 * home directory whose own name contains a backslash would misread.
 * TODO: replace with a host-stamped `separator` field on the wire
 * DirectoryListing so the platform fact travels verbatim (the trade-off is
 * recorded in the directory-picker capability seam Agent Note).
 */
function separatorOf(listing: DirectoryListing): '\\' | '/' {
  return listing.home.includes('\\') ? '\\' : '/'
}

/** The listed level as a directory part: its own path, separator-terminated (the root already is). */
function levelDirectory(listing: DirectoryListing): string {
  const sep = separatorOf(listing)
  return listing.path.endsWith(sep) ? listing.path : `${listing.path}${sep}`
}

/** The directory text a draft-following scan last sent, with the level path the host answered it with. */
interface ScannedDirectory {
  /** The draft's directory part, verbatim as it went to the host. */
  readonly directory: string
  /** `path` of the listing that came back. */
  readonly landed: string
}

/**
 * The draft's directory part — everything through its last separator — or
 * null while no separator has been typed at all (nothing addresses a
 * directory yet). The platform comes from `listing`: on Windows a forward
 * slash separates too (the host's `resolve` accepts either), while on POSIX a
 * backslash is a legal name character and never separates.
 */
function draftDirectory(listing: DirectoryListing, draft: string): string | null {
  const cut = separatorOf(listing) === '\\'
    ? Math.max(draft.lastIndexOf('\\'), draft.lastIndexOf('/'))
    : draft.lastIndexOf('/')
  return cut === -1 ? null : draft.slice(0, cut + 1)
}

/**
 * How the draft reads against one level: the directory part it names, and —
 * when `listing` is the level that directory part addresses — the final
 * segment that prefix-filters it while the user types (case-insensitively,
 * downstream). A level answers a directory part when its own path is that
 * part, or when it is the level that very text just produced (`scanned`): the
 * host resolves what it is given, so `..` segments and Windows forward
 * slashes reach a level whose path spells the request differently.
 * @param listing - the level to read the draft against.
 * @param draft - the current path draft.
 * @param scanned - the last draft-following scan's directory and landing.
 * @returns the draft's directory part (null with no separator typed) and its
 * filtering tail (null when this level does not answer that directory).
 */
function readDraft(
  listing: DirectoryListing,
  draft: string,
  scanned: ScannedDirectory | null,
): { directory: string | null; tail: string | null } {
  const directory = draftDirectory(listing, draft)
  if (directory === null) return { directory: null, tail: null }
  const answers = directory === levelDirectory(listing)
    || (scanned !== null && scanned.directory === directory && scanned.landed === listing.path)
  return { directory, tail: answers ? draft.slice(directory.length) : null }
}

/**
 * The rows the column renders after the hidden and prefix filters. A prefix
 * narrows the level only while some row it would actually show matches — a
 * tail nobody matches is a name being spelled, not a demand for an empty
 * column, so the level shows whole and its hidden rows return to obeying the
 * toggle. Counting only displayable rows is what keeps that true: were a
 * hidden row ever to match a prefix that does not reveal it (today `hidden`
 * means dot-prefixed, so it cannot), the level would narrow to nothing.
 */
function visibleEntries(
  entries: readonly DirectoryEntry[],
  showHidden: boolean,
  filterPrefix: string | null,
): readonly DirectoryEntry[] {
  const needle = filterPrefix === null ? '' : filterPrefix.toLowerCase()
  // A dot-led prefix names hidden entries explicitly, so matching ones
  // surface even while the toggle keeps the rest hidden.
  const displayable = (entry: DirectoryEntry): boolean => showHidden || !entry.hidden || needle.startsWith('.')
  const matches = (entry: DirectoryEntry): boolean => displayable(entry) && entry.name.toLowerCase().startsWith(needle)
  const narrowing = needle !== '' && entries.some(matches)
  return entries.filter((entry) => {
    if (narrowing) return matches(entry)
    return showHidden || !entry.hidden
  })
}

/** The ancestor crumb one level above `listing`, or null at the filesystem root. */
function parentCrumb(listing: DirectoryListing): DirectoryEntry | null {
  return listing.crumbs.at(-2) ?? null
}

/** One column of folder rows, optionally led by a synthetic `..` parent row. */
function LevelColumn({ entries, up, busy, onPick, showHidden, filterPrefix, pathEditing }: {
  entries: readonly DirectoryEntry[]
  up: DirectoryEntry | null
  busy: boolean
  onPick: (entry: DirectoryEntry) => void
  showHidden: boolean
  filterPrefix: string | null
  pathEditing: boolean
}) {
  const visible = visibleEntries(entries, showHidden, filterPrefix)
  const rows = up === null ? visible : [{ name: '..', path: up.path, hidden: false }, ...visible]
  return (
    <div className={css.column} role="list">
      {rows.map(entry => (
        // The wrapper carries the list semantics; the row keeps its NATIVE
        // button role so assistive technology exposes an actionable control.
        <span key={entry.path} role="listitem" className={css.rowSeat}>
          <button
            type="button"
            className={css.row}
            disabled={busy}
            // While the path editor is open, keep focus in it: a focus
            // steal on mousedown would blur the editor and (in engines
            // where the blur lands before our guards) drop this click.
            // Outside editing, rows keep native focus behavior.
            onMouseDown={pathEditing ? (event) => { event.preventDefault() } : undefined}
            onClick={() => { onPick(entry) }}
          >
            <IconFolderClose16 size={16} className={css.rowIcon} />
            <span className={css.rowName}>{entry.name}</span>
            <IconChevronRightOutline14 size={12} className={css.rowChevron} />
          </button>
        </span>
      ))}
    </div>
  )
}

/**
 * Render the directory-browser dialog.
 * @param props - owner-controlled browser props.
 * @returns the dialog element (null while closed, via Modal).
 */
export function DirectoryBrowser({ open, listDirectory, createDirectory, onOpen, onClose, busy, t }: DirectoryBrowserProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  // Derived from `loading` and `scanWindow` by the slow-scan effect below:
  // true only once the current listing call has been in flight for
  // SLOW_SCAN_DELAY_MS, so fast listings never render the indicator at all.
  const [slowScan, setSlowScan] = useState(false)
  // Every listing call owns a fresh silence window. `loading` may stay true
  // across a superseding row enter, so its boolean edge cannot identify the
  // start of each scan.
  const [scanWindow, setScanWindow] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // Path-edit state: null = breadcrumb mode; a string = the draft being typed.
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  // Show-hidden toggle state (pure client-side filter, reset on each open).
  const [showHidden, setShowHidden] = useState(false)
  // Create-folder state: null = closed; a string = the nested dialog's draft.
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  // The in-flight listing's controller: superseding intent aborts the wire
  // request too — the Host stops scanning — instead of only discarding the
  // eventual result while the scan keeps consuming host resources.
  const scanController = useRef<AbortController | null>(null)
  // Bumped on every open/close edge: settlements from a previous open (a
  // pending creation included) must never mutate a reopened dialog.
  const openGeneration = useRef(0)
  // Deep ancestry overflows the trail; keep its tail (the current directory
  // and the edit zone beside it) in view whenever the chain changes.
  const crumbTrailRef = useRef<HTMLSpanElement | null>(null)
  // IME confirmation (Enter selecting a candidate) must not submit either
  // text input; the same guard the workspace-name inputs carry, shared by
  // the path editor and the folder-name input.
  const composingRef = useRef(false)
  // HMR/unmount invalidation: a completion from a disposed flow must not
  // update state or issue follow-up requests from a dead component.
  useEffect(() => () => {
    requestSeq.current += 1
    openGeneration.current += 1
    scanController.current?.abort()
  }, [])
  const compositionGuard = {
    onCompositionStart: () => { composingRef.current = true },
    onCompositionEnd: () => { composingRef.current = false },
  }

  /** Newer intent wins: invalidate the pending listing's settlement AND abort its wire request. */
  const supersede = useCallback((): number => {
    scanController.current?.abort()
    scanController.current = null
    return ++requestSeq.current
  }, [])

  /** Hide any prior indicator and start a fresh silence window for one listing call. */
  const restartSlowScanWindow = useCallback((): void => {
    setSlowScan(false)
    setScanWindow(value => value + 1)
  }, [])

  /** Launch one listing under a fresh controller so a later supersession can abort it. */
  const launchListing = useCallback((path: string | undefined): { seq: number; scan: Promise<DirectoryListing> } => {
    const seq = supersede()
    const controller = new AbortController()
    scanController.current = controller
    restartSlowScanWindow()
    return { seq, scan: listDirectory(path, controller.signal) }
  }, [supersede, restartSlowScanWindow, listDirectory])

  /**
   * Enter owns the view from submission until its navigation lands, so the
   * debounce timer the same keystrokes armed must not supersede it. Cleared
   * by the next edit (and by opening the editor); a failed submission leaves
   * it set until the operator edits again, so the rejected path is not
   * immediately re-scanned as a preview.
   */
  const previewSuspended = useRef(false)

  // The column as the draft-following scan must read it when its wait
  // fires: current, but NOT a dependency of the wait (see the effect below).
  const viewRef = useRef<DirectoryListing | null>(null)
  useEffect(() => { viewRef.current = listing }, [listing])

  // What the last draft-following scan asked for and what came back, so a
  // level still answers the text that produced it after the host respelled
  // it. Stale entries are harmless: a match needs both the directory text and
  // that level's own path, which together already mean the same directory.
  const scanned = useRef<ScannedDirectory | null>(null)

  /**
   * A landed preview replaced the row a keyboard operator may have Tabbed
   * onto, so the focus it drops is re-parked on the still-open editor (the
   * Modal has no focus trap). Consumed by the refocus effect below.
   */
  const refocusPathInput = useRef(false)

  /**
   * Replace the column with a freshly scanned level. Until the commit, the
   * previous view keeps rendering: a landing swaps the rows, it never blanks
   * them.
   *
   * Two callers, one landing shape. A submitted path (Enter, a crumb, a row
   * enter) closes the editor on arrival and announces its failure. The
   * editor's own draft-following scan keeps both to itself: it is
   * speculative, nothing waits on it, and the stale view keeps rendering. A
   * failure leaves the last readable column standing and says nothing, while
   * an arrival clears the stale message and re-parks focus the swap dropped.
   * @param path - the level to list; absent lists the Host home directory.
   * @param options - `closeEditor` retires the path draft on arrival;
   * `announce` surfaces a failure as the dialog's alert.
   */
  const land = useCallback((path: string | undefined, options: { closeEditor: boolean; announce: boolean }) => {
    const { seq, scan } = launchListing(path)
    setLoading(true)
    if (options.announce) setError(null)
    scan.then((target) => {
      if (seq !== requestSeq.current) return
      // The level the column will present as current answers this exact
      // directory text, however the host respelled it (`..`, a Windows
      // forward slash): the tail filters, and the same text asks for no
      // second scan.
      if (!options.closeEditor && path !== undefined) scanned.current = { directory: path, landed: target.path }
      setListing(target)
      setLoading(false)
      if (options.closeEditor) {
        setPathDraft(null)
        return
      }
      setError(null)
      refocusPathInput.current = true
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      refocusList.current = false
      setLoading(false)
      if (options.announce) setError(failureText(reason))
    })
  }, [launchListing])

  /** Commit a submitted path (Enter, a crumb, a row enter, the initial home listing): the editor closes, failures surface. */
  const navigate = useCallback((path?: string) => {
    land(path, { closeEditor: true, announce: true })
  }, [land])

  // Editor-close focus parking (consumed by the refocus effect below the
  // list ref): a row enter parks on the replacement column's first row,
  // Enter and an input-focused Escape park on the crumb edit zone that
  // replaces the input. Pointer-out cancels never set (or clear) these —
  // yanking focus back from wherever the user clicked would be worse than
  // the fall.
  const refocusList = useRef(false)
  const refocusEditZone = useRef(false)
  const pathInputRef = useRef<HTMLInputElement | null>(null)
  const editZoneRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  /**
   * Walk the column to the directory the draft addresses, WITHOUT closing the
   * editor. Typing a path moves the listed level exactly as a crumb jump
   * does, and the draft's final segment prefix-filters the arrival from the
   * next render on.
   */
  const previewDraftLevel = useCallback((directory: string) => {
    land(directory, { closeEditor: false, announce: false })
  }, [land])

  /** Abandon path editing (Escape or clicking away) and restore the crumb view. */
  const cancelPathEdit = useCallback(() => {
    // Cancel also withdraws a navigation the editor already launched: its
    // late success must not jump to the cancelled path, so the pending
    // request is superseded and the view leaves the loading state.
    supersede()
    setLoading(false)
    setPathDraft(null)
    setError(null)
    // With no level listed yet (the editor superseded the initial home
    // listing), plain cancellation would leave a permanently blank picker:
    // restart the home listing.
    if (listing === null) navigate()
  }, [supersede, listing, navigate])

  /** Enter the clicked folder (or `..`) as the listed level. */
  const enter = useCallback((entry: DirectoryEntry) => {
    refocusList.current = true
    // A pick while the path editor is open adopts the row and closes the
    // editor immediately — the draft served its purpose. The listing still
    // lands asynchronously.
    setPathDraft(null)
    navigate(entry.path)
  }, [navigate])

  // Every open starts fresh at the Host home directory; closing invalidates
  // any in-flight response so a late arrival cannot repopulate a closed dialog.
  useEffect(() => {
    openGeneration.current += 1
    if (open) {
      setListing(null)
      setCreatingFolder(false)
      setShowHidden(false)
      navigate()
      return
    }
    supersede()
    // Closing mid-scan leaves nothing to load: without this edge the
    // slow-scan effect keeps arming while hidden and the reopened dialog
    // would show the indicator on its first frame instead of waiting out a
    // fresh silence window (reopen's navigate() produces no loading edge).
    setLoading(false)
    setError(null)
    setPathDraft(null)
    setFolderDraft(null)
    setCreateError(null)
    // A close mid-flight (failed Enter, then Cancel) may leave refocus
    // flags armed; retire them so a later render cannot consume them.
    refocusList.current = false
    refocusEditZone.current = false
  }, [open, navigate, supersede])

  /** The folder a create or Open acts on: the listed level. */
  const targetPath = listing?.path ?? null
  const targetName = listing === null
    ? ''
    : (displayCrumbs(listing, t('browser.home')).at(-1)?.name ?? listing.path)

  const confirmCreate = (): void => {
    /* v8 ignore next -- reentry fence: the nested dialog only renders with a target and disables while creating. */
    if (targetPath === null || folderDraft === null || creatingFolder) return
    // Trim only rejects an all-whitespace draft; the Host gets the original
    // spelling — the backend accepts any non-blank single segment verbatim,
    // and trimming here would create a different sibling.
    const name = folderDraft
    if (name.trim() === '') return
    setCreatingFolder(true)
    setCreateError(null)
    const generation = openGeneration.current
    createDirectory(targetPath, name).then((createdPath) => {
      // A settlement from a closed (possibly reopened) flow must not touch
      // the fresh dialog or issue a relist against the stale target.
      if (generation !== openGeneration.current) return
      setCreatingFolder(false)
      setFolderDraft(null)
      // Enter the created folder so Open adopts it, matching the previous
      // "create then select" confirm target without a preview pane.
      navigate(createdPath)
    }, (reason: unknown) => {
      if (generation !== openGeneration.current) return
      setCreatingFolder(false)
      setCreateError(failureText(reason))
    })
  }

  // The slow-scan gate for the loading indicator: each listing call restarts
  // the timer even when a superseding scan keeps `loading` continuously true.
  // A settle inside its own window means the swap happened with nothing shown.
  useEffect(() => {
    if (!loading) {
      setSlowScan(false)
      return
    }
    const timer = window.setTimeout(() => { setSlowScan(true) }, SLOW_SCAN_DELAY_MS)
    return () => { window.clearTimeout(timer) }
  }, [loading, scanWindow])

  // The column follows the draft: EVERY keystroke replaces the pending timer,
  // and the target is decided when it fires, off the column as it stands
  // then. Keying the wait on the draft (not on the directory part it names)
  // is what makes a keystroke that superseded an in-flight scan re-arm one,
  // and what lets an edit after a rejected submission release the hold the
  // submission took. The column is read through a ref for the converse
  // reason: were it a dependency, the landing this commits would re-arm the
  // wait, and a host answering with a differently spelled path would scan
  // forever.
  useEffect(() => {
    if (pathDraft === null) return
    const timer = window.setTimeout(() => {
      if (previewSuspended.current) return
      const current = viewRef.current
      if (current === null) return
      const { directory, tail } = readDraft(current, pathDraft, scanned.current)
      if (directory === null || tail !== null) return
      previewDraftLevel(directory)
    }, DRAFT_PREVIEW_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [pathDraft, previewDraftLevel])

  // After the hooks: a closed dialog renders nothing and evaluates no copy.
  const typedPrefix = listing === null || pathDraft === null
    ? null
    : readDraft(listing, pathDraft, scanned.current).tail
  const crumbs = listing === null ? [] : displayCrumbs(listing, t('browser.home'))
  const crumbTail = crumbs.at(-1)?.path
  const listingPath = listing?.path
  useEffect(() => {
    const trail = crumbTrailRef.current
    if (trail !== null) trail.scrollLeft = trail.scrollWidth
  }, [crumbTail])
  // Every editor exit that would drop focus to body re-parks it after
  // commit, so keyboard traversal stays inside the dialog (the Modal has no
  // focus trap): a row enter lands on the first row of the replacement
  // column, while Enter and an input-focused Escape land on the crumb edit
  // zone that replaces the input.
  const prevListingPath = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (refocusPathInput.current) {
      refocusPathInput.current = false
      // Only when the swap actually dropped focus to body: focus the operator
      // still holds (the input itself, a surviving row) stays theirs.
      if (document.activeElement === document.body) pathInputRef.current?.focus()
    }
    if (pathDraft !== null) {
      prevListingPath.current = listingPath
      return
    }
    const listingMoved = prevListingPath.current !== listingPath
    prevListingPath.current = listingPath
    if (refocusList.current && listingMoved) {
      refocusList.current = false
      refocusEditZone.current = false
      const host = listRef.current
      /* v8 ignore next -- narrowing guard: the list is mounted whenever a row enter just committed. */
      if (host === null) return
      const row = host.querySelector<HTMLButtonElement>('button')
      /* v8 ignore next -- narrowing guard: a landed level always has `..` or at least one host row, or is empty at root. */
      if (row === null) return
      row.focus()
      return
    }
    if (refocusEditZone.current) {
      refocusEditZone.current = false
      // Re-park only when the close actually dropped focus to body; focus
      // the user parked elsewhere (a surviving row) stays theirs.
      if (document.activeElement !== document.body) return
      const zone = editZoneRef.current
      /* v8 ignore next -- narrowing guard: crumb mode renders the edit zone whenever the editor just closed. */
      if (zone === null) return
      zone.focus()
    }
  })

  if (!open) return null
  // The nested create dialog owns the interaction while open: Modal has no
  // focus trap, so every parent control goes inert (Shift-Tab or AT must not
  // close, adopt, or retarget underneath the child).
  const parentInert = busy || folderDraft !== null
  // An uncommitted path draft makes targetPath stale relative to the header:
  // committing actions must not act on the previous listing while a different
  // path is displayed.
  const draftPending = pathDraft !== null

  return (
    <Modal
      open={open}
      // Escape and mask reach every mounted Modal's document listener; while
      // the nested create dialog is up only that topmost dialog may close
      // (its own guard keeps an in-flight creation open), and an in-flight
      // adoption pins the flow — dismissing it would leave the owner's
      // createWorkspace to land after an apparent cancel.
      onClose={() => { if (folderDraft === null && !busy) onClose() }}
      title={t('browser.title')}
      className={clsx(css.dialog)}
      headless
    >
      {/* Path-edit cancellation is observed at the card scope, not the
        * input: once Tab parks focus on a filtered row the input is off the
        * event path, yet Escape must still collapse the editor (not the
        * dialog) and a further focus move out of the card must still
        * cancel. display:contents keeps header/content/footer as direct
        * flex children of the Modal card. */}
      <div
        className={css.editorScope}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || pathDraft === null) return
          // stopPropagation keeps the card-scope Escape from the Modal's
          // document listener.
          event.stopPropagation()
          // Escape while the input holds focus is about to unmount it; with
          // focus already parked on a row, that row survives the cancel and
          // keeps focus naturally. Assignment (not a conditional set) also
          // retires a stale flag a failed Enter left.
          refocusEditZone.current = document.activeElement === pathInputRef.current
          cancelPathEdit()
        }}
        // Focus leaving THIS dialog card while editing cancels like Escape.
        // Guarded non-cancel paths: window/tab focus loss (document no
        // longer focused); a focus move that stays inside the card (Tab
        // onto the filtered rows or the footer toggle); and pointer paths,
        // where rows and the toggle suppress focus steal on mousedown while
        // editing so their click lands first. Enter keeps focus in the
        // input while its navigation is in flight, so a submitted path is
        // never withdrawn here. Anchored to this card via closest, not any
        // [role="dialog"], so focus escaping into a sibling overlay cancels.
        onBlur={(event) => {
          if (pathDraft === null) return
          if (!document.hasFocus()) return
          const card = event.currentTarget.closest('[role="dialog"]')
          /* v8 ignore next -- narrowing guard: this scope always renders inside the Modal card. */
          if (card === null) return
          if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return
          // The user moved focus out of the card themselves: cancel without
          // re-parking (a lingering Enter-failure flag must not yank focus
          // back either).
          refocusEditZone.current = false
          cancelPathEdit()
        }}
      >
        <div className={css.header}>
          <h2 className={css.title}>{t('browser.title')}</h2>
          <div className={css.crumbBar}>
            {pathDraft === null
              ? (
                <>
                  <span className={css.crumbTrail} role="navigation" ref={crumbTrailRef}>
                    {crumbs.map((crumb, index) => (
                      <span key={crumb.path} className={css.crumbSeat}>
                        {index > 0 && <IconChevronRightOutline14 size={12} className={css.crumbChevron} />}
                        <button
                          type="button"
                          className={css.crumb}
                          disabled={parentInert}
                          onClick={() => { navigate(crumb.path) }}
                        >
                          {crumb.name}
                        </button>
                      </span>
                    ))}
                  </span>
                  {/* The empty zone right of the crumbs is the path-edit
                    * affordance: the whole remainder of the bar clicks into
                    * the editor, and the pencil glyph parked at its right
                    * edge (with the same tooltip) is what says so — an
                    * invisible target the operator must guess at is the one
                    * way into typing a path. */}
                  <button
                    type="button"
                    className={css.crumbEditZone}
                    aria-label={t('browser.editPath')}
                    title={t('browser.editPath')}
                    // Stays available with no listed level: when the home
                    // listing itself fails, typing an absolute path is the one
                    // remaining way forward.
                    disabled={parentInert}
                    ref={editZoneRef}
                    onClick={() => {
                    // Opening the editor supersedes any pending listing: a
                    // settlement landing before the first keystroke would
                    // otherwise close the editor via navigate's draft reset.
                      supersede()
                      setLoading(false)
                      previewSuspended.current = false
                      // Seed with a trailing separator so typing immediately
                      // continues into child names (and prefix-filters below).
                      // No listed level means nothing to seed from (the editor
                      // is the recovery path for a failed home listing).
                      if (listing === null) {
                        setPathDraft('')
                        return
                      }
                      const sep = separatorOf(listing)
                      setPathDraft(listing.path.endsWith(sep) ? listing.path : `${listing.path}${sep}`)
                    }}
                  >
                    <IconEditOutline16 size={14} className={css.crumbEditGlyph} />
                  </button>
                </>
              )
              : (
                <input
                  className={css.pathInput}
                  value={pathDraft}
                  aria-label={t('browser.editPath')}
                  autoFocus
                  ref={pathInputRef}
                  disabled={parentInert}
                  onChange={(event) => {
                  // Editing the draft supersedes any in-flight navigation:
                  // its completion must neither clear the newer text nor
                  // repopulate the view with the older path.
                    supersede()
                    setLoading(false)
                    // A fresh edit releases the submission hold: the column
                    // may follow the new text wherever it points.
                    previewSuspended.current = false
                    setPathDraft(event.target.value)
                  }}
                  {...compositionGuard}
                  // Escape and focus-leave cancellation live on the card-scope
                  // wrapper above (they must work after focus Tabs onto the
                  // rows); this handler owns only submission.
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !composingRef.current) {
                      event.preventDefault()
                      // Trim only detects a blank draft; the Host gets the
                      // original text — a real directory name may end in
                      // whitespace, and trimming would list its sibling.
                      if (pathDraft.trim() !== '') {
                        // Success will unmount the still-focused input; park
                        // focus on the returning crumb edit zone (a failure
                        // keeps the editor, so the flag waits until close).
                        refocusEditZone.current = true
                        // The submitted path owns the view now: a debounce
                        // timer still pending from these keystrokes would
                        // otherwise supersede this navigation and land the
                        // draft's parent directory instead.
                        previewSuspended.current = true
                        navigate(pathDraft)
                      }
                    }
                  }}
                />
              )}
          </div>
        </div>
        <div className={css.content}>
          <div className={css.listRow} ref={listRef}>
            {listing !== null && (
              <LevelColumn
                entries={listing.entries}
                up={parentCrumb(listing)}
                busy={parentInert}
                onPick={enter}
                showHidden={showHidden}
                filterPrefix={typedPrefix}
                pathEditing={draftPending}
              />
            )}
          </div>
          {loading && slowScan
          && <div className={clsx(css.status, css.loadingFloat)} role="status">{t('browser.loading')}</div>}
          {/* The backend bounds a level at its complete-result limit; say so
          * whenever the visible column was cut instead of letting the tail of a
          * huge directory go silently missing. The note describes the rows
          * on screen, so an in-flight scan leaves it alone — hiding it while
          * the stale view still shows the cut level would shift the column
          * on every navigation away from it. */}
          {listing?.truncated === true
          && <div className={css.status} role="status">{t('browser.truncated')}</div>}
          {error !== null && <div className={css.error} role="alert">{error}</div>}
        </div>
        <div className={css.footerBar}>
          <Button
            variant="outline"
            icon={<IconPlusOutline16 size={14} />}
            disabled={listing === null || loading || parentInert || draftPending}
            onClick={() => {
              setFolderDraft('')
              setCreateError(null)
            }}
          >
            {t('browser.newFolder')}
          </Button>
          <button
            type="button"
            className={clsx(css.showHiddenToggle, showHidden && css.showHiddenToggleActive)}
            aria-pressed={showHidden}
            disabled={parentInert}
            // The toggle composes with the path editor (dot-led prefixes and
            // this filter interleave): while editing, don't steal focus, so
            // toggling never blur-cancels a draft mid-thought. Outside editing
            // it keeps native focus behavior.
            onMouseDown={draftPending ? (event) => { event.preventDefault() } : undefined}
            onClick={() => { setShowHidden(prev => !prev) }}
          >
            {t('browser.showHidden')}
            {/* Trailing check (Menu's selected vocabulary): the label never
              * shifts when the pressed state toggles. */}
            {showHidden && <IconCheckOutline16 size={14} />}
          </button>
          <span className={css.footerGap} />
          <Button variant="outline" className={clsx(css.footerAction)} disabled={parentInert} onClick={onClose}>{t('browser.cancel')}</Button>
          <Button
            variant="primary"
            className={clsx(css.footerAction)}
            disabled={targetPath === null || loading || parentInert || draftPending}
            /* v8 ignore next -- narrowing guard: Open disables while no target exists. */
            onClick={() => { if (targetPath !== null) onOpen(targetPath) }}
          >
            {t('browser.open')}
          </Button>
        </div>
      </div>
      {/* Nested create dialog (figma 813:23278): names one folder inside the target. */}
      <Modal
        open={folderDraft !== null}
        onClose={() => { if (!creatingFolder) setFolderDraft(null) }}
        title={t('browser.newFolder')}
        className={clsx(css.createDialog)}
        headless
      >
        <div className={css.createBody}>
          <h3 className={css.createTitle}>{t('browser.newFolder')}</h3>
          <p className={css.createIn}>{t('browser.createIn', { name: targetName })}</p>
          <input
            className={css.createInput}
            value={folderDraft ?? ''}
            aria-label={t('browser.folderName')}
            placeholder={t('browser.untitledFolder')}
            autoFocus
            disabled={creatingFolder}
            onChange={(event) => { setFolderDraft(event.target.value) }}
            {...compositionGuard}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !composingRef.current) {
                event.preventDefault()
                confirmCreate()
              }
              if (event.key === 'Escape') {
                event.stopPropagation()
                if (!creatingFolder) setFolderDraft(null)
              }
            }}
          />
          {createError !== null && <div className={css.error} role="alert">{createError}</div>}
          <div className={css.createActions}>
            <Button variant="outline" disabled={creatingFolder} onClick={() => { setFolderDraft(null) }}>{t('browser.cancel')}</Button>
            <Button
              variant="primary"
              disabled={creatingFolder || folderDraft === null || folderDraft.trim() === ''}
              onClick={confirmCreate}
            >
              {t('browser.create')}
            </Button>
          </div>
        </div>
      </Modal>
    </Modal>
  )
}
