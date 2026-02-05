import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { logger } from "../utils/logger.js";

interface ProjectsData {
  projects: Record<string, string>; // name → path
  activeProject: Record<string, string>; // chatId → project name
}

export class ProjectManager {
  private projects = new Map<string, string>();
  private activeProject = new Map<number, string>();
  private filePath: string;
  private defaultDir: string;

  constructor(dataDir: string, defaultDir: string) {
    this.filePath = join(dataDir, "projects.json");
    this.defaultDir = defaultDir;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data: ProjectsData = JSON.parse(raw);
      for (const [name, path] of Object.entries(data.projects || {})) {
        this.projects.set(name, path);
      }
      for (const [chatId, name] of Object.entries(data.activeProject || {})) {
        this.activeProject.set(parseInt(chatId, 10), name);
      }
      logger.info({ count: this.projects.size }, "Projects loaded");
    } catch {
      logger.info("No existing projects file, starting fresh");
    }
  }

  async save(): Promise<void> {
    const data: ProjectsData = {
      projects: Object.fromEntries(this.projects),
      activeProject: Object.fromEntries(
        Array.from(this.activeProject.entries()).map(([k, v]) => [String(k), v])
      ),
    };
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2));
    logger.debug("Projects saved");
  }

  list(): Map<string, string> {
    return new Map(this.projects);
  }

  add(name: string, path: string): void {
    this.projects.set(name, path);
  }

  remove(name: string): boolean {
    return this.projects.delete(name);
  }

  getActiveProjectName(chatId: number): string | undefined {
    return this.activeProject.get(chatId);
  }

  getActiveProjectDir(chatId: number): string | undefined {
    const name = this.activeProject.get(chatId);
    if (!name) return this.defaultDir;
    return this.projects.get(name) || this.defaultDir;
  }

  switchProject(chatId: number, name: string): string | undefined {
    const path = this.projects.get(name);
    if (!path) return undefined;
    this.activeProject.set(chatId, name);
    return path;
  }

  clearActive(chatId: number): void {
    this.activeProject.delete(chatId);
  }
}
