# Agent Note: Single-column directory browser with enter-on-click and `..`

Status: implemented

English | [中文](2026-08-16-directory-browser-single-column-enter.zh.md)

## Problem

The in-app Select Workspace Directory dialog used a Miller two-column preview: a row click selected a folder and listed its children beside it, without entering. Operators coming from ordinary folder browsers expected a click to enter, and there was no `..` row to walk up one level. Breadcrumb jumps and path editing could move up, but the listing itself only went deeper. The extra pane duplicated "where I am" without making parent navigation obvious.

## Decision

The browse client's `DirectoryBrowser` is a **single column of the listed level**. A row click **enters** that folder (lists it). Away from the filesystem root the column leads with a synthetic `..` row whose path is the listing's parent crumb; a click lists that parent. The filesystem root omits `..`. **Open** adopts the listed level. **New folder** still targets the listed level, then enters the created folder so Open adopts it.

Quiet navigation, the click-to-edit path bar, draft-following scans, the show-hidden toggle, and the nested create dialog stay as decided in the [directory-picker capability seam](../architecture/2026-07-28-directory-picker-capability-seam.md). Those mechanics no longer land a parent-plus-child two-pane frame or keep a selected row as a preview anchor: one listing call replaces the column, and prefix filtering applies to that column (with `..` always leading when a parent exists).

This note owns the listing interaction. The seam note still owns capability kind, host listing policy, and the path-editor cancel/separator rulings; its Miller-pane facts are superseded here.

## Alternatives considered

- **Keep Miller preview, add only a `..` row.** Rejected: the preview pane is the complaint. A `..` row next to a sibling preview still requires understanding two columns, and Open's target (selected vs listed) stays ambiguous.
- **Replace the crumb bar with a permanent path field plus Go, as in some file managers.** Rejected again for the reason recorded on the seam note: the crumb bar already answers "where am I"; this change only removes the preview pane and adds `..`.
- **Host-emitted `..` entries.** Rejected: the host lists real children only and already rejects creating `.` / `..`. The parent walk is a client affordance over `crumbs`, which the host already stamps.

## Consequences

- Clicking a folder lists its children; clicking `..` lists the parent, including above Home (the display-root crumb collapse does not hide the parent walk).
- There is no selected-but-not-entered folder: Open and New folder always act on the listed path.
- Two-pane landing, the 200ms parent-leg wait, and selection-anchored crumb jumps are gone. Tests and the workspace-management aria golden pin the single column and the leading `..`.
