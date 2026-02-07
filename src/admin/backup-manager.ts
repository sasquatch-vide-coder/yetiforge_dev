import { readdir, copyFile, mkdir, rm, stat, readFile } from "fs/promises";
import { join } from "path";
import { createReadStream } from "fs";
import { logger } from "../utils/logger.js";

export interface BackupInfo {
  id: string;
  timestamp: number;
  files: string[];
  sizeBytes: number;
}

const DATA_FILES = [
  "admin.json",
  "agent-config.json",
  "bot-config.json",
  "sessions.json",
  "web-chat.json",
  "config-history.json",
  "alerts.json",
  "invocations.db",
];

export class BackupManager {
  private dataDir: string;
  private backupDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.backupDir = join(dataDir, "backups");
  }

  async createBackup(): Promise<BackupInfo> {
    const id = `backup-${Date.now()}`;
    const backupPath = join(this.backupDir, id);
    await mkdir(backupPath, { recursive: true });

    const copiedFiles: string[] = [];
    let totalSize = 0;

    for (const file of DATA_FILES) {
      const srcPath = join(this.dataDir, file);
      try {
        const fileStat = await stat(srcPath);
        if (fileStat.isFile()) {
          await copyFile(srcPath, join(backupPath, file));
          copiedFiles.push(file);
          totalSize += fileStat.size;
        }
      } catch {
        // File doesn't exist, skip
      }
    }

    const info: BackupInfo = {
      id,
      timestamp: Date.now(),
      files: copiedFiles,
      sizeBytes: totalSize,
    };

    // Save backup metadata
    const metaPath = join(backupPath, "_meta.json");
    const { writeFile } = await import("fs/promises");
    await writeFile(metaPath, JSON.stringify(info, null, 2));

    logger.info({ id, files: copiedFiles.length, sizeBytes: totalSize }, "Backup created");
    return info;
  }

  async listBackups(): Promise<BackupInfo[]> {
    try {
      await mkdir(this.backupDir, { recursive: true });
      const entries = await readdir(this.backupDir, { withFileTypes: true });
      const backups: BackupInfo[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("backup-")) continue;

        const metaPath = join(this.backupDir, entry.name, "_meta.json");
        try {
          const raw = await readFile(metaPath, "utf-8");
          backups.push(JSON.parse(raw));
        } catch {
          // Try to reconstruct from directory contents
          const dirPath = join(this.backupDir, entry.name);
          const files = await readdir(dirPath);
          const dataFiles = files.filter((f) => f !== "_meta.json");
          const timestamp = parseInt(entry.name.replace("backup-", ""), 10) || 0;
          backups.push({
            id: entry.name,
            timestamp,
            files: dataFiles,
            sizeBytes: 0,
          });
        }
      }

      return backups.sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  async restoreBackup(id: string): Promise<{ restoredFiles: string[] }> {
    const backupPath = join(this.backupDir, id);

    // Verify backup exists
    try {
      await stat(backupPath);
    } catch {
      throw new Error(`Backup '${id}' not found`);
    }

    const files = await readdir(backupPath);
    const dataFiles = files.filter((f) => f !== "_meta.json");
    const restoredFiles: string[] = [];

    for (const file of dataFiles) {
      const srcPath = join(backupPath, file);
      const destPath = join(this.dataDir, file);
      try {
        await copyFile(srcPath, destPath);
        restoredFiles.push(file);
      } catch (err) {
        logger.error({ err, file }, "Failed to restore file from backup");
      }
    }

    logger.info({ id, restoredFiles }, "Backup restored");
    return { restoredFiles };
  }

  async deleteBackup(id: string): Promise<boolean> {
    const backupPath = join(this.backupDir, id);
    try {
      await rm(backupPath, { recursive: true, force: true });
      logger.info({ id }, "Backup deleted");
      return true;
    } catch {
      return false;
    }
  }

  getBackupPath(id: string): string {
    return join(this.backupDir, id);
  }
}
