// /api/drive — connecting Google Drive for backups (server/drive.ts), and what
// it holds. Restoring from it is POST /api/drive/restore, in routes/backup.ts
// beside the restore it shares.
import type { ServerResponse } from 'node:http'
import { connectDrive, disconnectDrive, driveStatus, listDriveBackups } from '../drive.ts'
import { json } from '../lib/http.ts'

// Listing needs Google, and Google being unreachable must not blank the rest
// of the row — so a failed listing is reported beside the status, not instead.
export async function handleGetDrive(res: ServerResponse): Promise<void> {
  const status = driveStatus()
  let backups: Awaited<ReturnType<typeof listDriveBackups>> = []
  let listError: string | null = null
  if (status.connected) {
    try {
      backups = await listDriveBackups()
    } catch (err) {
      listError = err instanceof Error ? err.message : String(err)
    }
  }
  json(res, 200, { ...status, backups, listError })
}

export async function handleConnectDrive(res: ServerResponse): Promise<void> {
  if (!driveStatus().configured) {
    return json(res, 409, {
      error: 'Google Drive is not set up on this install.',
      code: 'drive_not_configured',
    })
  }
  try {
    json(res, 200, await connectDrive())
  } catch (err) {
    json(res, 502, { error: err instanceof Error ? err.message : 'Could not reach Google.' })
  }
}

export async function handleDisconnectDrive(res: ServerResponse): Promise<void> {
  await disconnectDrive()
  json(res, 200, driveStatus())
}
