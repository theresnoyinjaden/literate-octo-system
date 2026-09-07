#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync, unlinkSync, watchFile, unwatchFile } from "fs";
import { glob } from "glob";
import * as path from "path";
import * as http from "http";
import * as url from "url";

const server = new Server(
  {
    name: "superdesign-mcp-server",
    version: "1.0.0",
  }
);

// Tool schemas for Superdesign functionality
const GenerateDesignSchema = z.object({
  prompt: z.string().describe("Design prompt describing what to create"),
  design_type: z.enum(["ui", "wireframe", "component", "logo", "icon"]).describe("Type of design to generate"),
  variations: z.number().min(1).max(5).default(3).describe("Number of design variations to create"),
  framework: z.enum(["html", "react", "vue"]).default("html").describe("Framework for UI components")
});

const IterateDesignSchema = z.object({
  design_file: z.string().describe("Path to existing design file to iterate on"),
  feedback: z.string().describe("Feedback for improving the design"),
  variations: z.number().min(1).max(5).default(3).describe("Number of design variations to create")
});

const ExtractDesignSystemSchema = z.object({
  image_path: z.string().describe("Path to screenshot/image to extract design system from")
});

const ListDesignsSchema = z.object({
  workspace_path: z.string().optional().describe("Workspace path (defaults to current directory)")
});

const GallerySchema = z.object({
  workspace_path: z.string().optional().describe("Workspace path (defaults to current directory)")
});

const DeleteDesignSchema = z.object({
  filename: z.string().describe("Name of the design file to delete"),
  workspace_path: z.string().optional().describe("Workspace path (defaults to current directory)")
});

const CleanupSchema = z.object({
  workspace_path: z.string().optional().describe("Workspace path (defaults to current directory)"),
  max_age_days: z.number().optional().describe("Delete designs older than X days (default: 30)"),
  max_count: z.number().optional().describe("Keep only the latest X designs (default: 50)"),
  dry_run: z.boolean().optional().describe("Show what would be deleted without actually deleting")
});

const LiveGallerySchema = z.object({
  workspace_path: z.string().optional().describe("Workspace path (defaults to current directory)"),
  port: z.number().optional().describe("Port for the live gallery server (default: 3000)")
});

const CheckFilesSchema = z.object({
  workspace_path: z.string().optional().describe("Workspace path (defaults to current directory)"),
  manifest: z.array(z.object({
    name: z.string(),
    size: z.number(),
    modified: z.number()
  })).describe("File manifest to compare against")
});

// Get or create superdesign directory
function getSuperdeignDirectory(workspacePath?: string): string {
  const basePath = workspacePath || process.cwd();
  const superdesignDir = path.join(basePath, 'superdesign');
  
  if (!existsSync(superdesignDir)) {
    mkdirSync(superdesignDir, { recursive: true });
  }
  
  const designIterationsDir = path.join(superdesignDir, 'design_iterations');
  if (!existsSync(designIterationsDir)) {
    mkdirSync(designIterationsDir, { recursive: true });
  }
  
  const designSystemDir = path.join(superdesignDir, 'design_system');
  if (!existsSync(designSystemDir)) {
    mkdirSync(designSystemDir, { recursive: true });
  }
  
  return superdesignDir;
}

// Design metadata interface
interface DesignMetadata {
  fileName: string;
  filePath: string;
  createdAt: string;
  fileSize: number;
  designType: string;
  prompt?: string;
  framework?: string;
}

// Get or create metadata file
function getMetadataFilePath(superdesignDir: string): string {
  return path.join(superdesignDir, 'metadata.json');
}

// Load existing metadata
function loadMetadata(superdesignDir: string): DesignMetadata[] {
  const metadataPath = getMetadataFilePath(superdesignDir);
  if (!existsSync(metadataPath)) {
    return [];
  }
  
  try {
    const data = readFileSync(metadataPath, 'utf8');
    return JSON.parse(data) as DesignMetadata[];
  } catch (error) {
    console.error('Error loading metadata:', error);
    return [];
  }
}

// Save metadata
function saveMetadata(superdesignDir: string, metadata: DesignMetadata[]): void {
  const metadataPath = getMetadataFilePath(superdesignDir);
  try {
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving metadata:', error);
  }
}

// Add or update design metadata
function updateDesignMetadata(superdesignDir: string, fileName: string, designType: string, prompt?: string, framework?: string): void {
  const designIterationsDir = path.join(superdesignDir, 'design_iterations');
  const filePath = path.join(designIterationsDir, fileName);
  
  if (!existsSync(filePath)) {
    return;
  }
  
  const stats = statSync(filePath);
  const metadata = loadMetadata(superdesignDir);
  
  // Remove existing entry for this file
  const filteredMetadata = metadata.filter(m => m.fileName !== fileName);
  
  // Add new entry
  const newEntry: DesignMetadata = {
    fileName,
    filePath,
    createdAt: stats.birthtime.toISOString(),
    fileSize: stats.size,
    designType,
    prompt,
    framework
  };
  
  filteredMetadata.push(newEntry);
  saveMetadata(superdesignDir, filteredMetadata);
}

// Get design metadata with file stats
function getDesignMetadata(superdesignDir: string): DesignMetadata[] {
  const metadata = loadMetadata(superdesignDir);
  const designIterationsDir = path.join(superdesignDir, 'design_iterations');
  
  // Update metadata for existing files and remove entries for deleted files
  const updatedMetadata: DesignMetadata[] = [];
  
  for (const entry of metadata) {
    const filePath = path.join(designIterationsDir, entry.fileName);
    if (existsSync(filePath)) {
      const stats = statSync(filePath);
      updatedMetadata.push({
        ...entry,
        filePath,
        fileSize: stats.size,
        createdAt: entry.createdAt || stats.birthtime.toISOString()
      });
    }
  }
  
  saveMetadata(superdesignDir, updatedMetadata);
  return updatedMetadata;
}

// Cleanup settings interface
interface CleanupSettings {
  maxAgeDays: number;
  maxCount: number;
  enabled: boolean;
}

// Get or create cleanup settings
function getCleanupSettings(superdesignDir: string): CleanupSettings {
  const settingsPath = path.join(superdesignDir, 'cleanup-settings.json');
  const defaultSettings: CleanupSettings = {
    maxAgeDays: 30,
    maxCount: 50,
    enabled: true
  };
  
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2), 'utf8');
    return defaultSettings;
  }
  
  try {
    const data = readFileSync(settingsPath, 'utf8');
    return { ...defaultSettings, ...JSON.parse(data) };
  } catch (error) {
    console.error('Error loading cleanup settings:', error);
    return defaultSettings;
  }
}

// Save cleanup settings
function saveCleanupSettings(superdesignDir: string, settings: CleanupSettings): void {
  const settingsPath = path.join(superdesignDir, 'cleanup-settings.json');
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving cleanup settings:', error);
  }
}

// Perform cleanup based on settings
function performCleanup(superdesignDir: string, maxAgeDays?: number, maxCount?: number, dryRun: boolean = false): { deleted: string[], kept: string[], errors: string[] } {
  const settings = getCleanupSettings(superdesignDir);
  const actualMaxAge = maxAgeDays ?? settings.maxAgeDays;
  const actualMaxCount = maxCount ?? settings.maxCount;
  
  const metadata = getDesignMetadata(superdesignDir);
  const now = new Date();
  const cutoffDate = new Date(now.getTime() - (actualMaxAge * 24 * 60 * 60 * 1000));
  
  // Sort by creation date (newest first)
  const sortedMetadata = metadata.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  
  const deleted: string[] = [];
  const kept: string[] = [];
  const errors: string[] = [];
  
  for (let i = 0; i < sortedMetadata.length; i++) {
    const design = sortedMetadata[i];
    const createdAt = new Date(design.createdAt);
    const shouldDelete = i >= actualMaxCount || createdAt < cutoffDate;
    
    if (shouldDelete) {
      if (!dryRun) {
        try {
          const designIterationsDir = path.join(superdesignDir, 'design_iterations');
          const filePath = path.join(designIterationsDir, design.fileName);
          
          if (existsSync(filePath)) {
            unlinkSync(filePath);
            // Remove from metadata
            const allMetadata = loadMetadata(superdesignDir);
            const filteredMetadata = allMetadata.filter(m => m.fileName !== design.fileName);
            saveMetadata(superdesignDir, filteredMetadata);
          }
          
          deleted.push(design.fileName);
        } catch (error: any) {
          errors.push(`Failed to delete ${design.fileName}: ${error.message}`);
        }
      } else {
        deleted.push(design.fileName);
      }
    } else {
      kept.push(design.fileName);
    }
  }
  
  return { deleted, kept, errors };
}

// Generate base filename from prompt
function generateBaseName(prompt: string): string {
  return prompt.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 20);
}

// File checking for smart refresh integration
interface FileStatus {
  name: string;
  size: number;
  modified: number;
  exists: boolean;
}

function checkFileChanges(superdesignDir: string, manifest: Array<{name: string; size: number; modified: number}>): {hasChanges: boolean; changes: Array<{file: string; type: 'added' | 'modified' | 'deleted'}>} {
  const designIterationsDir = path.join(superdesignDir, 'design_iterations');
  const currentFiles = glob.sync('*.{html,svg}', { cwd: designIterationsDir });
  const changes: Array<{file: string; type: 'added' | 'modified' | 'deleted'}> = [];
  
  // Check for new or modified files
  currentFiles.forEach(file => {
    const filePath = path.join(designIterationsDir, file);
    if (existsSync(filePath)) {
      const stats = statSync(filePath);
      const manifestEntry = manifest.find(m => m.name === file);
      
      if (!manifestEntry) {
        // New file
        changes.push({ file, type: 'added' });
      } else if (stats.size !== manifestEntry.size || stats.mtime.getTime() !== manifestEntry.modified) {
        // Modified file
        changes.push({ file, type: 'modified' });
      }
    }
  });
  
  // Check for deleted files
  manifest.forEach(manifestEntry => {
    if (!currentFiles.includes(manifestEntry.name)) {
      changes.push({ file: manifestEntry.name, type: 'deleted' });
    }
  });
  
  return {
    hasChanges: changes.length > 0,
    changes
  };
}

// File watcher for live gallery updates
interface FileWatcher {
  watchedFiles: Set<string>;
  clients: Set<http.ServerResponse>;
  superdesignDir: string;
  cleanup?: () => void;
}

const activeWatchers = new Map<string, FileWatcher>();

function startFileWatcher(superdesignDir: string): FileWatcher {
  const designIterationsDir = path.join(superdesignDir, 'design_iterations');
  
  if (activeWatchers.has(superdesignDir)) {
    return activeWatchers.get(superdesignDir)!;
  }
  
  const watcher: FileWatcher = {
    watchedFiles: new Set(),
    clients: new Set(),
    superdesignDir
  };
  
  // Watch for new files in design_iterations directory
  const watchDir = () => {
    if (existsSync(designIterationsDir)) {
      const files = glob.sync('*.{html,svg}', { cwd: designIterationsDir });
      
      // Watch new files
      files.forEach(file => {
        const fullPath = path.join(designIterationsDir, file);
        if (!watcher.watchedFiles.has(fullPath)) {
          watcher.watchedFiles.add(fullPath);
          watchFile(fullPath, { interval: 1000 }, () => {
            notifyClients(watcher, 'file_changed', { file, type: 'modified' });
          });
        }
      });
      
      // Unwatch deleted files
      watcher.watchedFiles.forEach(filePath => {
        if (!existsSync(filePath)) {
          unwatchFile(filePath);
          watcher.watchedFiles.delete(filePath);
          const fileName = path.basename(filePath);
          notifyClients(watcher, 'file_changed', { file: fileName, type: 'deleted' });
        }
      });
      
      // Check for new files
      const currentFiles = new Set(files.map(f => path.join(designIterationsDir, f)));
      const newFiles = [...currentFiles].filter(f => !watcher.watchedFiles.has(f));
      
      if (newFiles.length > 0) {
        newFiles.forEach(filePath => {
          const fileName = path.basename(filePath);
          notifyClients(watcher, 'file_changed', { file: fileName, type: 'added' });
        });
      }
    }
  };
  
  // Initial watch setup
  watchDir();
  
  // Watch for directory changes every 2 seconds
  const interval = setInterval(watchDir, 2000);
  
  // Store cleanup function
  watcher.cleanup = () => {
    clearInterval(interval);
    watcher.watchedFiles.forEach(filePath => unwatchFile(filePath));
    watcher.clients.clear();
  };
  
  activeWatchers.set(superdesignDir, watcher);
  return watcher;
}

function notifyClients(watcher: FileWatcher, event: string, data: any): void {
  const message = `data: ${JSON.stringify({ event, data })}\n\n`;
  
  watcher.clients.forEach(client => {
    try {
      client.write(message);
    } catch (error) {
      // Client disconnected, remove from set
      watcher.clients.delete(client);
    }
  });
}

function stopFileWatcher(superdesignDir: string): void {
  const watcher = activeWatchers.get(superdesignDir);
  if (watcher) {
    watcher.cleanup?.();
    activeWatchers.delete(superdesignDir);
  }
}

// Live gallery server
function createLiveGalleryServer(superdesignDir: string, port: number = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url || '', true);
      const pathname = parsedUrl.pathname;
      
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }
      
      if (pathname === '/') {
        // Serve the gallery HTML
        try {
          const designIterationsDir = path.join(superdesignDir, 'design_iterations');
          const designFiles = glob.sync('*.{html,svg}', { cwd: designIterationsDir });
          const galleryHtml = generateLiveGalleryHTML(designFiles, superdesignDir);
          
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(galleryHtml);
        } catch (error: any) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Error generating gallery: ${error.message}`);
        }
      } else if (pathname === '/events') {
        // Server-Sent Events endpoint
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        
        const watcher = startFileWatcher(superdesignDir);
        watcher.clients.add(res);
        
        // Send initial connection message
        res.write('data: {"event": "connected", "data": {}}\n\n');
        
        // Clean up when client disconnects
        req.on('close', () => {
          watcher.clients.delete(res);
        });
      } else if (pathname?.startsWith('/design_iterations/')) {
        // Serve design files
        const fileName = pathname.substring('/design_iterations/'.length);
        const filePath = path.join(superdesignDir, 'design_iterations', fileName);
        
        if (existsSync(filePath)) {
          const ext = path.extname(fileName).toLowerCase();
          const contentType = ext === '.html' ? 'text/html' : 
                            ext === '.svg' ? 'image/svg+xml' : 'text/plain';
          
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(readFileSync(filePath));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('File not found');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });
    
    server.listen(port, () => {
      resolve(`http://localhost:${port}`);
    });
    
    server.on('error', (error) => {
      reject(error);
    });
  });
}

// Generate live gallery HTML with real-time updates
function generateLiveGalleryHTML(designFiles: string[], superdesignDir: string): string {
  const metadata = getDesignMetadata(superdesignDir);
  const metadataMap = new Map(metadata.map(m => [m.fileName, m]));
  
  const designCards = designFiles.map((file, index) => {
    const fileExtension = path.extname(file).toLowerCase();
    const fileName = path.basename(file, fileExtension);
    const relativePath = `/design_iterations/${file}`;
    const fileMetadata = metadataMap.get(file);
    
    let previewContent = '';
    if (fileExtension === '.html') {
      previewContent = `<iframe src="${relativePath}" loading="lazy"></iframe>`;
    } else if (fileExtension === '.svg') {
      previewContent = `<object data="${relativePath}" type="image/svg+xml" class="svg-preview"></object>`;
    }
    
    // Format file size
    const formatFileSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };
    
    // Format date
    const formatDate = (dateString: string) => {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    };
    
    return `
      <div class="design-card" data-file="${file}" data-created="${fileMetadata?.createdAt || ''}">
        <div class="design-header">
          <div class="design-title">
            <h3>${fileName}</h3>
            <span class="design-type">${fileExtension.toUpperCase()}</span>
          </div>
          <div class="design-meta">
            ${fileMetadata ? `
              <span class="design-size">${formatFileSize(fileMetadata.fileSize)}</span>
              <span class="design-date">${formatDate(fileMetadata.createdAt)}</span>
            ` : ''}
          </div>
        </div>
        <div class="design-preview">
          ${previewContent}
        </div>
        <div class="design-actions">
          <button onclick="openFullscreen('${relativePath}')" class="btn-primary">View Full</button>
          <button onclick="copyPath('${relativePath}')" class="btn-secondary">Copy Path</button>
          <button onclick="deleteDesign('${file}')" class="btn-danger">Delete</button>
        </div>
      </div>
    `;
  }).join('');
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Superdesign Live Gallery</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        :root {
            --bg-primary: #ffffff;
            --bg-secondary: #f8fafc;
            --bg-card: #ffffff;
            --text-primary: #1a202c;
            --text-secondary: #718096;
            --border-color: #e2e8f0;
            --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            --shadow-hover: 0 10px 25px -5px rgba(0, 0, 0, 0.2);
            --accent-color: #4299e1;
        }
        
        [data-theme="dark"] {
            --bg-primary: #1a202c;
            --bg-secondary: #2d3748;
            --bg-card: #2d3748;
            --text-primary: #f7fafc;
            --text-secondary: #a0aec0;
            --border-color: #4a5568;
            --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
            --shadow-hover: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
        }
        
        body {
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            padding: 20px;
            transition: background 0.3s ease, color 0.3s ease;
        }
        
        .header {
            margin-bottom: 40px;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }
        
        .header-content h1 {
            font-size: 2.5rem;
            color: var(--text-primary);
            margin-bottom: 8px;
            font-weight: 600;
            letter-spacing: -0.02em;
        }
        
        .header-content p {
            color: var(--text-secondary);
            font-size: 1rem;
            font-weight: 400;
        }
        
        .header-controls {
            display: flex;
            gap: 12px;
            align-items: center;
        }
        
        .live-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 20px;
            font-size: 0.875rem;
            color: var(--text-secondary);
        }
        
        .live-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #48bb78;
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .theme-toggle {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            padding: 8px 16px;
            border-radius: 8px;
            cursor: pointer;
            font-family: inherit;
            font-size: 0.875rem;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .theme-toggle:hover {
            background: var(--bg-secondary);
            transform: translateY(-1px);
        }
        
        .gallery-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
            gap: 24px;
            max-width: 1400px;
        }
        
        .design-card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            box-shadow: var(--shadow);
            overflow: hidden;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        
        .design-card:hover {
            transform: translateY(-4px);
            box-shadow: var(--shadow-hover);
        }
        
        .design-card.new-file {
            border-color: var(--accent-color);
            box-shadow: 0 0 0 2px rgba(66, 153, 225, 0.1);
        }
        
        .design-header {
            padding: 16px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }
        
        .design-title {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .design-title h3 {
            color: var(--text-primary);
            font-size: 1rem;
            font-weight: 500;
            font-family: inherit;
        }
        
        .design-type {
            background: var(--bg-secondary);
            color: var(--text-secondary);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 400;
            font-family: inherit;
        }
        
        .design-meta {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 2px;
        }
        
        .design-size, .design-date {
            color: var(--text-secondary);
            font-size: 0.75rem;
            font-family: inherit;
        }
        
        .design-date {
            opacity: 0.8;
        }
        
        .design-preview {
            height: 300px;
            position: relative;
            overflow: hidden;
        }
        
        .design-preview iframe {
            width: 100%;
            height: 100%;
            border: none;
            transform: scale(0.5);
            transform-origin: top left;
            width: 200%;
            height: 200%;
        }
        
        .design-preview .svg-preview {
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: var(--bg-primary);
        }
        
        .design-actions {
            padding: 16px;
            display: flex;
            gap: 8px;
        }
        
        .btn-primary {
            background: var(--accent-color);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 0.875rem;
            font-family: inherit;
            cursor: pointer;
            transition: background 0.2s ease;
        }
        
        .btn-primary:hover {
            background: #3182ce;
        }
        
        .btn-secondary {
            background: var(--bg-secondary);
            color: var(--text-secondary);
            border: 1px solid var(--border-color);
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 0.875rem;
            font-family: inherit;
            cursor: pointer;
            transition: background 0.2s ease;
        }
        
        .btn-secondary:hover {
            background: var(--border-color);
        }
        
        .btn-danger {
            background: #e53e3e;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 0.875rem;
            font-family: inherit;
            cursor: pointer;
            transition: background 0.2s ease;
        }
        
        .btn-danger:hover {
            background: #c53030;
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--text-secondary);
        }
        
        .empty-state h3 {
            font-size: 1.25rem;
            margin-bottom: 8px;
        }
        
        @media (max-width: 768px) {
            .gallery-grid {
                grid-template-columns: 1fr;
            }
            
            .design-preview {
                height: 200px;
            }
            
            .header {
                flex-direction: column;
                gap: 16px;
                align-items: flex-start;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-content">
            <h1>superdesign.live</h1>
            <p id="file-count">${designFiles.length} designs found</p>
        </div>
        <div class="header-controls">
            <div class="live-indicator">
                <div class="live-dot"></div>
                <span id="connection-status">Connecting...</span>
            </div>
            <button class="theme-toggle" onclick="toggleTheme()">
                <span id="theme-icon">🌙</span>
                <span id="theme-text">Dark</span>
            </button>
        </div>
    </div>
    
    <div class="gallery-grid" id="gallery-grid">
        ${designCards}
    </div>
    
    <script>
        // Theme management
        const theme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeButton();
        
        function toggleTheme() {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            updateThemeButton();
        }
        
        function updateThemeButton() {
            const theme = document.documentElement.getAttribute('data-theme');
            const icon = document.getElementById('theme-icon');
            const text = document.getElementById('theme-text');
            
            if (theme === 'dark') {
                icon.textContent = '☀️';
                text.textContent = 'Light';
            } else {
                icon.textContent = '🌙';
                text.textContent = 'Dark';
            }
        }
        
        function openFullscreen(path) {
            window.open(path, '_blank');
        }
        
        function copyPath(path) {
            navigator.clipboard.writeText(path).then(() => {
                showToast('Path copied to clipboard!', 'success');
            });
        }
        
        function deleteDesign(fileName) {
            if (confirm(\`Are you sure you want to delete \${fileName}?\`)) {
                showToast('Delete functionality via MCP server!', 'info');
            }
        }
        
        function showToast(message, type = 'info') {
            const colors = {
                success: '#48bb78',
                error: '#e53e3e',
                info: '#4299e1',
                warning: '#ed8936'
            };
            
            const toast = document.createElement('div');
            toast.textContent = message;
            toast.style.cssText = \`
                position: fixed;
                top: 20px;
                right: 20px;
                background: \${colors[type] || colors.info};
                color: white;
                padding: 12px 20px;
                border-radius: 6px;
                z-index: 1000;
                font-size: 14px;
                font-family: inherit;
                animation: slideIn 0.3s ease;
            \`;
            
            document.body.appendChild(toast);
            setTimeout(() => {
                toast.style.animation = 'slideOut 0.3s ease';
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }
        
        // Server-Sent Events for live updates
        let eventSource;
        
        function connectToEvents() {
            eventSource = new EventSource('/events');
            
            eventSource.onopen = function() {
                document.getElementById('connection-status').textContent = 'Live';
                showToast('Connected to live updates!', 'success');
            };
            
            eventSource.onmessage = function(event) {
                const data = JSON.parse(event.data);
                handleFileChange(data.event, data.data);
            };
            
            eventSource.onerror = function() {
                document.getElementById('connection-status').textContent = 'Disconnected';
                showToast('Connection lost, attempting to reconnect...', 'warning');
                
                // Attempt to reconnect after 3 seconds
                setTimeout(() => {
                    eventSource.close();
                    connectToEvents();
                }, 3000);
            };
        }
        
        function handleFileChange(event, data) {
            const { file, type } = data;
            
            if (type === 'added') {
                showToast(\`New design added: \${file}\`, 'success');
                // Refresh the gallery to show new file
                setTimeout(() => location.reload(), 1000);
            } else if (type === 'deleted') {
                showToast(\`Design deleted: \${file}\`, 'info');
                // Remove the card from the DOM
                const card = document.querySelector(\`[data-file="\${file}"]\`);
                if (card) {
                    card.style.animation = 'fadeOut 0.3s ease';
                    setTimeout(() => card.remove(), 300);
                    updateFileCount();
                }
            } else if (type === 'modified') {
                showToast(\`Design updated: \${file}\`, 'info');
                // Highlight the modified file
                const card = document.querySelector(\`[data-file="\${file}"]\`);
                if (card) {
                    card.classList.add('new-file');
                    setTimeout(() => card.classList.remove('new-file'), 3000);
                    
                    // Refresh the iframe if it's an HTML file
                    const iframe = card.querySelector('iframe');
                    if (iframe) {
                        iframe.src = iframe.src;
                    }
                }
            }
        }
        
        function updateFileCount() {
            const cards = document.querySelectorAll('.design-card');
            document.getElementById('file-count').textContent = \`\${cards.length} designs found\`;
        }
        
        // Add CSS animations
        const style = document.createElement('style');
        style.textContent = \`
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
            @keyframes fadeOut {
                from { opacity: 1; transform: scale(1); }
                to { opacity: 0; transform: scale(0.8); }
            }
        \`;
        document.head.appendChild(style);
        
        // Connect to live updates
        connectToEvents();
    </script>
</body>
</html>`;
}

// Superdesign system prompt
const SUPERDESIGN_SYSTEM_PROMPT = `# Role
You are a **senior front-end designer**.
You pay close attention to every pixel, spacing, font, color;
Whenever there are UI implementation task, think deeply of the design style first, and then implement UI bit by bit

# When asked to create design:
1. Build one single html page of just one screen to build a design based on users' feedback/task
2. You ALWAYS output design files in 'superdesign/design_iterations' folder as {design_name}_{n}.html (Where n needs to be unique like table_1.html, table_2.html, etc.) or svg file
3. If you are iterating design based on existing file, then the naming convention should be {current_file_name}_{n}.html, e.g. if we are iterating ui_1.html, then each version should be ui_1_1.html, ui_1_2.html, etc.

## When asked to design UI:
1. Similar process as normal design task, but refer to 'UI design & implementation guidelines' for guidelines

## When asked to update or iterate design:
1. Don't edit the existing design, just create a new html file with the same name but with _n.html appended to the end, e.g. if we are iterating ui_1.html, then each version should be ui_1_1.html, ui_1_2.html, etc.

## When asked to design logo or icon:
1. Copy/duplicate existing svg file but name it based on our naming convention in design_ierations folder, and then make edits to the copied svg file (So we can avoid lots of mistakes), like 'original_filename.svg superdesign/design-iterations/new_filename.svg'
2. Very important sub agent copy first, and Each agent just copy & edit a single svg file with svg code
3. you should focus on the the correctness of the svg code

## When asked to design a component:
1. Similar process as normal design task, and each agent just create a single html page with component inside;
2. Focus just on just one component itself, and don't add any other elements or text
3. Each HTML just have one component with mock data inside

## When asked to design wireframes:
1. Focus on minimal line style black and white wireframes, no colors, and never include any images, just try to use css to make some placeholder images. (Don't use service like placehold.co too, we can't render it)
2. Don't add any annotation of styles, just basic wireframes like Balsamiq style
3. Focus on building out the flow of the wireframes

# When asked to extract design system from images:
Your goal is to extract a generalized and reusable design system from the screenshots provided, **without including specific image content**, so that frontend developers or AI agents can reference the JSON as a style foundation for building consistent UIs.

1. Analyze the screenshots provided:
   * Color palette
   * Typography rules
   * Spacing guidelines
   * Layout structure (grids, cards, containers, etc.)
   * UI components (buttons, inputs, tables, etc.)
   * Border radius, shadows, and other visual styling patterns
2. Create a design-system.json file in 'design_system' folder that clearly defines these rules and can be used to replicate the visual language in a consistent way.
3. if design-system.json already exist, then create a new file with the name design-system_{n}.json (Where n needs to be unique like design-system_1.json, design-system_2.json, etc.)

**Constraints**

* Do **not** extract specific content from the screenshots (no text, logos, icons).
* Focus purely on *design principles*, *structure*, and *styles*.

--------

# UI design & implementation guidelines:

## Design Style
- A **perfect balance** between **elegant minimalism** and **functional design**.
- **Soft, refreshing gradient colors** that seamlessly integrate with the brand palette.
- **Well-proportioned white space** for a clean layout.
- **Light and immersive** user experience.
- **Clear information hierarchy** using **subtle shadows and modular card layouts**.
- **Natural focus on core functionalities**.
- **Refined rounded corners**.
- **Delicate micro-interactions**.
- **Comfortable visual proportions**.
- **Responsive design** You only output responsive design, it needs to look perfect on both mobile, tablet and desktop.
    - If its a mobile app, also make sure you have responsive design OR make the center the mobile UI

## Technical Specifications
1. **Images**: do NEVER include any images, we can't render images in webview,just try to use css to make some placeholder images. (Don't use service like placehold.co too, we can't render it)
2. **Styles**: Use **Tailwind CSS** via **CDN** for styling. (Use !important declarations for critical design tokens that must not be overridden, Load order management - ensure custom styles load after framework CSS, CSS-in-JS or scoped styles to avoid global conflicts, Use utility-first approach - define styles using Tailwind classes instead of custom CSS when possible)
3. **Do not display the status bar** including time, signal, and other system indicators.
4. **All text should be only black or white**.
5. Choose a **4 pt or 8 pt spacing system**—all margins, padding, line-heights, and element sizes must be exact multiples.
6. Use **consistent spacing tokens** (e.g., 4, 8, 16, 24, 32px) — never arbitrary values like 5 px or 13 px.
7. Apply **visual grouping** ("spacing friendship"): tighter gaps (4–8px) for related items, larger gaps (16–24px) for distinct groups.
8. Ensure **typographic rhythm**: font‑sizes, line‑heights, and spacing aligned to the grid (e.g., 16 px text with 24 px line-height).
9. Maintain **touch-area accessibility**: buttons and controls should meet or exceed 48×48 px, padded using grid units.

## 🎨 Color Style
* Use a **minimal palette**: default to **black, white, and neutrals**—no flashy gradients or mismatched hues .
* Follow a **60‑30‑10 ratio**: ~60% background (white/light gray), ~30% surface (white/medium gray), ~10% accents (charcoal/black) .
* Accent colors limited to **one subtle tint** (e.g., charcoal black or very soft beige). Interactive elements like links or buttons use this tone sparingly.
* Always check **contrast** for text vs background via WCAG (≥4.5:1)

## ✍️ Typography & Hierarchy

### 1. 🎯 Hierarchy Levels & Structure
* Always define at least **three typographic levels**: **Heading (H1)**, **Subheading (H2)**, and **Body**.
* Use **size, weight, color**, and **spacing** to create clear differences between them.
* H1 should stand out clearly (largest & boldest), H2 should be distinctly smaller/medium-weight, and body remains readable and lighter.

### 2. 📏 Size & Scale
* Follow a modular scale: e.g., **H1: 36px**, **H2: 28px**, **Body: 16px** (min). Adjust for mobile if needed .
* Maintain strong contrast—don't use size differences of only 2px; aim for at least **6–8px difference** between levels .

### 3. 🧠 Weight, Style & Color
* Use **bold or medium weight** for headings, **regular** for body.
* Utilize **color contrast** (e.g., darker headings, neutral body) to support hierarchy.
* Avoid excessive styles like italics or uppercase—unless used sparingly for emphasis or subheadings.

### 4. ✂️ Spacing & Rhythm
* Add **0.8×–1.5× line-height** for body and headings to improve legibility.
* Use consistent **margin spacing above/below headings** (e.g., margin-top: 1.2× line-height) .
`;

// Generate enhanced gallery HTML with smart refresh detection
function generateGalleryHTML(designFiles: string[], superdesignDir: string): string {
  const metadata = getDesignMetadata(superdesignDir);
  const metadataMap = new Map(metadata.map(m => [m.fileName, m]));
  
  // Generate file manifest for change detection
  const fileManifest = designFiles.map(file => {
    const fileMetadata = metadataMap.get(file);
    const designIterationsDir = path.join(superdesignDir, 'design_iterations');
    const filePath = path.join(designIterationsDir, file);
    const stats = existsSync(filePath) ? statSync(filePath) : null;
    
    return {
      name: file,
      size: stats?.size || 0,
      modified: stats?.mtime.getTime() || 0,
      created: fileMetadata?.createdAt || stats?.birthtime.toISOString() || new Date().toISOString()
    };
  });
  
  const designCards = designFiles.map((file, index) => {
    const fileExtension = path.extname(file).toLowerCase();
    const fileName = path.basename(file, fileExtension);
    const relativePath = `./design_iterations/${file}`;
    const fileMetadata = metadataMap.get(file);
    const manifest = fileManifest.find(f => f.name === file);
    
    let previewContent = '';
    if (fileExtension === '.html') {
      previewContent = `<iframe src="${relativePath}" loading="lazy" data-file="${file}"></iframe>`;
    } else if (fileExtension === '.svg') {
      previewContent = `<object data="${relativePath}" type="image/svg+xml" class="svg-preview" data-file="${file}"></object>`;
    }
    
    // Format file size
    const formatFileSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };
    
    // Format date
    const formatDate = (dateString: string): string => {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    };
    
    return `
      <div class="design-card" data-file="${file}" data-created="${fileMetadata?.createdAt || ''}" data-modified="${manifest?.modified || 0}">
        <div class="design-header">
          <div class="design-title">
            <h3>${fileName}</h3>
            <span class="design-type">${fileExtension.toUpperCase()}</span>
          </div>
          <div class="design-meta">
            ${fileMetadata ? `
              <span class="design-size">${formatFileSize(fileMetadata.fileSize)}</span>
              <span class="design-date">${formatDate(fileMetadata.createdAt)}</span>
            ` : manifest ? `
              <span class="design-size">${formatFileSize(manifest.size)}</span>
              <span class="design-date">${formatDate(manifest.created)}</span>
            ` : ''}
          </div>
        </div>
        <div class="design-preview">
          ${previewContent}
        </div>
        <div class="design-actions">
          <button onclick="openFullscreen('${relativePath}')" class="btn-primary">View Full</button>
          <button onclick="copyPath('${relativePath}')" class="btn-secondary">Copy Path</button>
          <button onclick="deleteDesign('${file}')" class="btn-danger">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Superdesign Gallery</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        :root {
            --bg-primary: #ffffff;
            --bg-secondary: #f8fafc;
            --bg-card: #ffffff;
            --text-primary: #1a202c;
            --text-secondary: #718096;
            --border-color: #e2e8f0;
            --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            --shadow-hover: 0 10px 25px -5px rgba(0, 0, 0, 0.2);
        }
        
        [data-theme="dark"] {
            --bg-primary: #1a202c;
            --bg-secondary: #2d3748;
            --bg-card: #2d3748;
            --text-primary: #f7fafc;
            --text-secondary: #a0aec0;
            --border-color: #4a5568;
            --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
            --shadow-hover: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
        }
        
        body {
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            padding: 20px;
            transition: background 0.3s ease, color 0.3s ease;
        }
        
        .header {
            margin-bottom: 40px;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }
        
        .header-content h1 {
            font-size: 2.5rem;
            color: var(--text-primary);
            margin-bottom: 8px;
            font-weight: 600;
            letter-spacing: -0.02em;
        }
        
        .header-content p {
            color: var(--text-secondary);
            font-size: 1rem;
            font-weight: 400;
        }
        
        .header-controls {
            display: flex;
            gap: 12px;
            align-items: center;
        }
        
        .refresh-controls {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        
        .auto-refresh-toggle {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.875rem;
            color: var(--text-secondary);
            cursor: pointer;
            user-select: none;
        }
        
        .auto-refresh-toggle input[type="checkbox"] {
            width: 16px;
            height: 16px;
            accent-color: var(--text-primary);
        }
        
        .btn-secondary {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            padding: 6px 12px;
            border-radius: 6px;
            cursor: pointer;
            font-family: inherit;
            font-size: 0.875rem;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .btn-secondary:hover {
            background: var(--bg-secondary);
            transform: translateY(-1px);
        }
        
        .btn-secondary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .btn-secondary:disabled:hover {
            transform: none;
        }
        
        .theme-toggle {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            padding: 8px 16px;
            border-radius: 8px;
            cursor: pointer;
            font-family: inherit;
            font-size: 0.875rem;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .theme-toggle:hover {
            background: var(--bg-secondary);
            transform: translateY(-1px);
        }
        
        .updated-indicator {
            position: absolute;
            top: 8px;
            right: 8px;
            width: 12px;
            height: 12px;
            background: #48bb78;
            border-radius: 50%;
            border: 2px solid var(--bg-card);
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .refresh-indicator {
            display: inline-block;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        .gallery-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
            gap: 24px;
            max-width: 1400px;
        }
        
        .design-card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            box-shadow: var(--shadow);
            overflow: hidden;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        
        .design-card:hover {
            transform: translateY(-4px);
            box-shadow: var(--shadow-hover);
        }
        
        .design-header {
            padding: 16px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }
        
        .design-title {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .design-title h3 {
            color: var(--text-primary);
            font-size: 1rem;
            font-weight: 500;
            font-family: inherit;
        }
        
        .design-type {
            background: var(--bg-secondary);
            color: var(--text-secondary);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 400;
            font-family: inherit;
        }
        
        .design-meta {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 2px;
        }
        
        .design-size, .design-date {
            color: var(--text-secondary);
            font-size: 0.75rem;
            font-family: inherit;
        }
        
        .design-date {
            opacity: 0.8;
        }
        
        .design-preview {
            height: 300px;
            position: relative;
            overflow: hidden;
        }
        
        .design-preview iframe {
            width: 100%;
            height: 100%;
            border: none;
            transform: scale(0.5);
            transform-origin: top left;
            width: 200%;
            height: 200%;
        }
        
        .design-preview .svg-preview {
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: var(--bg-primary);
        }
        
        .design-actions {
            padding: 16px;
            display: flex;
            gap: 8px;
        }
        
        .btn-primary {
            background: #4299e1;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 0.875rem;
            font-family: inherit;
            cursor: pointer;
            transition: background 0.2s ease;
        }
        
        .btn-primary:hover {
            background: #3182ce;
        }
        
        .btn-secondary {
            background: var(--bg-secondary);
            color: var(--text-secondary);
            border: 1px solid var(--border-color);
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 0.875rem;
            font-family: inherit;
            cursor: pointer;
            transition: background 0.2s ease;
        }
        
        .btn-secondary:hover {
            background: var(--border-color);
        }
        
        .btn-danger {
            background: #e53e3e;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 0.875rem;
            font-family: inherit;
            cursor: pointer;
            transition: background 0.2s ease;
        }
        
        .btn-danger:hover {
            background: #c53030;
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #718096;
        }
        
        .empty-state h3 {
            font-size: 1.25rem;
            margin-bottom: 8px;
        }
        
        @media (max-width: 768px) {
            .gallery-grid {
                grid-template-columns: 1fr;
            }
            
            .design-preview {
                height: 200px;
            }
            
            .header {
                flex-direction: column;
                gap: 16px;
                align-items: flex-start;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-content">
            <h1>superdesign.gallery</h1>
            <p id="file-count">${designFiles.length} designs found</p>
        </div>
        <div class="header-controls">
            <div class="refresh-controls">
                <button id="refresh-btn" class="btn-secondary" onclick="refreshGallery()">
                    <span id="refresh-icon">🔄</span>
                    <span id="refresh-text">Refresh</span>
                </button>
                <label class="auto-refresh-toggle">
                    <input type="checkbox" id="auto-refresh" onchange="toggleAutoRefresh()">
                    <span>Auto-refresh</span>
                </label>
            </div>
            <button class="theme-toggle" onclick="toggleTheme()">
                <span id="theme-icon">🌙</span>
                <span id="theme-text">Dark</span>
            </button>
        </div>
    </div>
    
    <div class="gallery-grid">
        ${designCards}
    </div>
    
    <script>
        // Theme management
        const theme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeButton();
        
        function toggleTheme() {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            updateThemeButton();
        }
        
        function updateThemeButton() {
            const theme = document.documentElement.getAttribute('data-theme');
            const icon = document.getElementById('theme-icon');
            const text = document.getElementById('theme-text');
            
            if (theme === 'dark') {
                icon.textContent = '☀️';
                text.textContent = 'Light';
            } else {
                icon.textContent = '🌙';
                text.textContent = 'Dark';
            }
        }
        
        function openFullscreen(path) {
            window.open(path, '_blank');
        }
        
        function copyPath(path) {
            navigator.clipboard.writeText(path).then(() => {
                showToast('Path copied to clipboard!', 'success');
            });
        }
        
        function deleteDesign(fileName) {
            if (confirm(\`Are you sure you want to delete \${fileName}?\`)) {
                // This would need to be implemented as an MCP tool
                // For now, just show a message
                showToast('Delete functionality coming soon!', 'info');
            }
        }
        
        function showToast(message, type = 'info') {
            const colors = {
                success: '#48bb78',
                error: '#e53e3e',
                info: '#4299e1',
                warning: '#ed8936'
            };
            
            const toast = document.createElement('div');
            toast.textContent = message;
            toast.style.cssText = \`
                position: fixed;
                top: 20px;
                right: 20px;
                background: \${colors[type] || colors.info};
                color: white;
                padding: 12px 20px;
                border-radius: 6px;
                z-index: 1000;
                font-size: 14px;
                font-family: inherit;
                animation: slideIn 0.3s ease;
            \`;
            
            document.body.appendChild(toast);
            setTimeout(() => {
                toast.style.animation = 'slideOut 0.3s ease';
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }
        
        // File manifest for change detection
        // This manifest is generated by the MCP server and embedded in the gallery
        // In production, this could be updated via WebSocket or Server-Sent Events
        const fileManifest = \${JSON.stringify(fileManifest)};
        
        // Integration status
        let mcpIntegrationAvailable = false;
        
        // Check if MCP integration is available (for future WebSocket/SSE integration)
        async function checkMcpIntegration() {
            try {
                // This is where we could check for WebSocket or SSE endpoints
                // For now, we'll use the static manifest approach
                mcpIntegrationAvailable = false;
                return mcpIntegrationAvailable;
            } catch (error) {
                console.log('MCP real-time integration not available, using static mode');
                return false;
            }
        }
        let lastUpdateCheck = Date.now();
        let autoRefreshInterval;
        let isRefreshing = false;
        
        // Smart refresh functionality
        function refreshGallery() {
            if (isRefreshing) return;
            
            isRefreshing = true;
            const refreshBtn = document.getElementById('refresh-btn');
            const refreshIcon = document.getElementById('refresh-icon');
            const refreshText = document.getElementById('refresh-text');
            
            // Show loading state
            refreshBtn.disabled = true;
            refreshIcon.classList.add('refresh-indicator');
            refreshText.textContent = 'Refreshing...';
            
            // Check for file changes
            checkForFileChanges()
                .then(hasChanges => {
                    if (hasChanges) {
                        // Reload the page to get updated content
                        location.reload();
                    } else {
                        showToast('Gallery is up to date', 'info');
                    }
                })
                .catch(error => {
                    showToast('Error checking for updates', 'error');
                    console.error('Refresh error:', error);
                })
                .finally(() => {
                    // Reset loading state
                    isRefreshing = false;
                    refreshBtn.disabled = false;
                    refreshIcon.classList.remove('refresh-indicator');
                    refreshText.textContent = 'Refresh';
                });
        }
        
        async function checkForFileChanges() {
            try {
                // For static gallery, we'll use a smart polling approach
                // In a real production environment, this would connect to the MCP server
                // via WebSocket or Server-Sent Events for real-time updates
                
                // Get current file stats from iframe document timestamps
                const currentFiles = await getCurrentFileStats();
                let hasChanges = false;
                
                // Compare with manifest
                for (const currentFile of currentFiles) {
                    const manifestFile = fileManifest.find(f => f.name === currentFile.name);
                    if (!manifestFile) {
                        // New file detected
                        hasChanges = true;
                        break;
                    }
                    // Use a more lenient comparison for iframe-based detection
                    const timeDiff = Math.abs(currentFile.modified - manifestFile.modified);
                    if (timeDiff > 1000) { // Allow 1 second tolerance
                        // File potentially changed
                        markFileAsUpdated(currentFile.name);
                        hasChanges = true;
                    }
                }
                
                // Check for deleted files
                const currentFileNames = new Set(currentFiles.map(f => f.name));
                for (const manifestFile of fileManifest) {
                    if (!currentFileNames.has(manifestFile.name)) {
                        // File deleted
                        hasChanges = true;
                        break;
                    }
                }
                
                return hasChanges;
            } catch (error) {
                console.error('Error checking file changes:', error);
                return false;
            }
        }
        
        async function getCurrentFileStats() {
            // Enhanced file detection using multiple methods
            const iframes = document.querySelectorAll('iframe[data-file]');
            const files = [];
            
            for (const iframe of iframes) {
                const fileName = iframe.getAttribute('data-file');
                if (fileName) {
                    let lastModified = Date.now();
                    
                    try {
                        // Try to get file info from iframe document
                        if (iframe.contentDocument?.lastModified) {
                            lastModified = new Date(iframe.contentDocument.lastModified).getTime();
                        }
                        
                        // Alternative: check if iframe has loaded successfully
                        const iframeLoaded = iframe.contentDocument && 
                                           iframe.contentDocument.readyState === 'complete';
                        
                        if (!iframeLoaded) {
                            // File might be missing or corrupted
                            lastModified = 0;
                        }
                        
                        // Try to get estimated file size from content length
                        let estimatedSize = 0;
                        if (iframe.contentDocument?.documentElement) {
                            estimatedSize = iframe.contentDocument.documentElement.outerHTML.length;
                        }
                        
                        files.push({
                            name: fileName,
                            modified: lastModified,
                            size: estimatedSize
                        });
                    } catch (error) {
                        // Cross-origin or other access issues
                        files.push({
                            name: fileName,
                            modified: Date.now(),
                            size: 0
                        });
                    }
                }
            }
            
            return files;
        }
        
        function toggleAutoRefresh() {
            const autoRefreshCheckbox = document.getElementById('auto-refresh');
            
            if (autoRefreshCheckbox.checked) {
                // Start auto-refresh every 5 seconds
                autoRefreshInterval = setInterval(() => {
                    if (!isRefreshing) {
                        checkForFileChanges().then(hasChanges => {
                            if (hasChanges) {
                                showToast('Changes detected, refreshing...', 'info');
                                setTimeout(() => location.reload(), 1000);
                            }
                        });
                    }
                }, 5000);
                
                showToast('Auto-refresh enabled (5s interval)', 'success');
            } else {
                // Stop auto-refresh
                if (autoRefreshInterval) {
                    clearInterval(autoRefreshInterval);
                    autoRefreshInterval = null;
                }
                showToast('Auto-refresh disabled', 'info');
            }
        }
        
        // Enhanced file change detection with visual indicators
        function markFileAsUpdated(fileName) {
            const card = document.querySelector(\`[data-file="\${fileName}"]\`);
            if (card) {
                // Add updated indicator
                const indicator = document.createElement('div');
                indicator.className = 'updated-indicator';
                indicator.title = 'File updated';
                card.style.position = 'relative';
                card.appendChild(indicator);
                
                // Remove indicator after 5 seconds
                setTimeout(() => {
                    indicator.remove();
                }, 5000);
            }
        }
        
        // Initialize auto-refresh state from localStorage
        const autoRefreshEnabled = localStorage.getItem('autoRefresh') === 'true';
        document.getElementById('auto-refresh').checked = autoRefreshEnabled;
        if (autoRefreshEnabled) {
            toggleAutoRefresh();
        }
        
        // Save auto-refresh state
        document.getElementById('auto-refresh').addEventListener('change', () => {
            localStorage.setItem('autoRefresh', document.getElementById('auto-refresh').checked);
        });
        
        // Add CSS animations
        const style = document.createElement('style');
        style.textContent = \`
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        \`;
        document.head.appendChild(style);
    </script>
</body>
</html>`;
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "superdesign_generate",
        description: "Returns design specifications for Claude Code to generate UI designs, wireframes, components, logos, or icons",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Design prompt describing what to create" },
            design_type: { 
              type: "string", 
              enum: ["ui", "wireframe", "component", "logo", "icon"],
              description: "Type of design to generate" 
            },
            variations: { 
              type: "number", 
              minimum: 1, 
              maximum: 5, 
              default: 3,
              description: "Number of design variations to create" 
            },
            framework: {
              type: "string",
              enum: ["html", "react", "vue"],
              default: "html",
              description: "Framework for UI components"
            }
          },
          required: ["prompt", "design_type"],
        },
      },
      {
        name: "superdesign_iterate",
        description: "Returns iteration instructions based on existing design and feedback",
        inputSchema: {
          type: "object",
          properties: {
            design_file: { type: "string", description: "Path to existing design file to iterate on" },
            feedback: { type: "string", description: "Feedback for improving the design" },
            variations: { 
              type: "number", 
              minimum: 1, 
              maximum: 5, 
              default: 3,
              description: "Number of design variations to create" 
            }
          },
          required: ["design_file", "feedback"],
        },
      },
      {
        name: "superdesign_extract_system",
        description: "Returns instructions for extracting design system from screenshot or image",
        inputSchema: {
          type: "object",
          properties: {
            image_path: { type: "string", description: "Path to screenshot/image to extract design system from" }
          },
          required: ["image_path"],
        },
      },
      {
        name: "superdesign_list",
        description: "List all created designs in the workspace",
        inputSchema: {
          type: "object",
          properties: {
            workspace_path: { type: "string", description: "Workspace path (defaults to current directory)" }
          },
        },
      },
      {
        name: "superdesign_gallery",
        description: "Generate an HTML gallery to view all designs in a browser",
        inputSchema: {
          type: "object",
          properties: {
            workspace_path: { type: "string", description: "Workspace path (defaults to current directory)" }
          },
        },
      },
      {
        name: "superdesign_delete",
        description: "Delete a design file and update metadata",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "Name of the design file to delete" },
            workspace_path: { type: "string", description: "Workspace path (defaults to current directory)" }
          },
          required: ["filename"],
        },
      },
      {
        name: "superdesign_cleanup",
        description: "Clean up old design files based on age and count limits",
        inputSchema: {
          type: "object",
          properties: {
            workspace_path: { type: "string", description: "Workspace path (defaults to current directory)" },
            max_age_days: { type: "number", description: "Delete designs older than X days (default: 30)" },
            max_count: { type: "number", description: "Keep only the latest X designs (default: 50)" },
            dry_run: { type: "boolean", description: "Show what would be deleted without actually deleting" }
          },
        },
      },
      {
        name: "superdesign_live_gallery",
        description: "Start a live gallery server with real-time updates and file watching",
        inputSchema: {
          type: "object",
          properties: {
            workspace_path: { type: "string", description: "Workspace path (defaults to current directory)" },
            port: { type: "number", description: "Port for the live gallery server (default: 3000)" }
          },
        },
      },
      {
        name: "superdesign_check_files",
        description: "Check for file changes by comparing current files with a manifest (for gallery refresh integration)",
        inputSchema: {
          type: "object",
          properties: {
            workspace_path: { type: "string", description: "Workspace path (defaults to current directory)" },
            manifest: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  size: { type: "number" },
                  modified: { type: "number" }
                },
                required: ["name", "size", "modified"]
              },
              description: "File manifest to compare against"
            }
          },
          required: ["manifest"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "superdesign_generate": {
        const { prompt, design_type, variations, framework } = GenerateDesignSchema.parse(args);
        
        const superdesignDir = getSuperdeignDirectory();
        const designIterationsDir = path.join(superdesignDir, 'design_iterations');
        const baseName = generateBaseName(prompt);
        const extension = (design_type === 'logo' || design_type === 'icon') ? 'svg' : 'html';
        
        // Create file list for variations
        const fileList = [];
        for (let i = 1; i <= variations; i++) {
          fileList.push(`${baseName}_${i}.${extension}`);
        }
        
        // Build design specifications
        let specifications = `DESIGN SPECIFICATION FOR CLAUDE CODE:

IMPORTANT: You must generate and save the following design files based on these specifications.

=== DESIGN PARAMETERS ===
- Type: ${design_type}
- Prompt: ${prompt}
- Framework: ${framework}
- Files to create: ${variations} variations
- File format: ${extension.toUpperCase()}

=== FILES TO CREATE ===
${fileList.map((file, index) => `${index + 1}. ${path.join(designIterationsDir, file)}`).join('\n')}

=== DESIGN GUIDELINES ===
${design_type === 'wireframe' ? '- Create minimal black and white wireframes with no colors\n- Use simple line styles like Balsamiq\n- No annotations or decorative elements' : ''}
${design_type === 'component' ? `- Generate a single ${framework} component with mock data\n- Focus only on the component itself\n- Include proper component structure for ${framework}` : ''}
${design_type === 'logo' || design_type === 'icon' ? '- Create proper SVG code with vector graphics\n- Ensure SVG is valid and well-structured\n- Focus on clean, scalable design' : ''}
${design_type === 'ui' ? '- Create complete responsive HTML interface\n- Use Tailwind CSS via CDN\n- Follow all UI design guidelines below' : ''}

=== SUPERDESIGN SYSTEM PROMPT ===
${SUPERDESIGN_SYSTEM_PROMPT}

=== EXECUTION INSTRUCTIONS ===
1. Create the superdesign/design_iterations directory if it doesn't exist
2. Generate ${variations} unique variations of the ${design_type} based on the prompt: "${prompt}"
3. Save each variation with the exact filenames listed above
4. Each variation should be different but follow the same design brief
5. Follow all Superdesign guidelines and constraints
6. **AFTER ALL ${variations} FILES ARE COMPLETED**: Use the superdesign_gallery tool to generate and automatically open the gallery
7. **DO NOT** open individual design files - only open the gallery at the end

**WORKFLOW:**
- Step 1-5: Create all design files
- Step 6: Call superdesign_gallery tool (which will auto-open the gallery)
- Step 7: User will see all designs in the integrated gallery interface

Please proceed to create these ${variations} design files now, then automatically generate and open the gallery.`;

        return {
          content: [{ type: "text", text: specifications }],
        };
      }

      case "superdesign_iterate": {
        const { design_file, feedback, variations } = IterateDesignSchema.parse(args);
        
        if (!existsSync(design_file)) {
          return {
            content: [{ type: "text", text: `Error: Design file ${design_file} does not exist` }],
          };
        }

        const originalContent = readFileSync(design_file, 'utf8');
        const superdesignDir = getSuperdeignDirectory();
        const designIterationsDir = path.join(superdesignDir, 'design_iterations');
        
        const baseName = path.basename(design_file, path.extname(design_file));
        const extension = path.extname(design_file).substring(1);
        
        // Create file list for iterations
        const fileList = [];
        for (let i = 1; i <= variations; i++) {
          fileList.push(`${baseName}_${i}.${extension}`);
        }
        
        let specifications = `DESIGN ITERATION SPECIFICATION FOR CLAUDE CODE:

IMPORTANT: You must iterate on the existing design and save the improved versions.

=== ITERATION PARAMETERS ===
- Original file: ${design_file}
- Feedback: ${feedback}
- Files to create: ${variations} improved variations
- File format: ${extension.toUpperCase()}

=== FILES TO CREATE ===
${fileList.map((file, index) => `${index + 1}. ${path.join(designIterationsDir, file)}`).join('\n')}

=== ORIGINAL DESIGN ===
${originalContent}

=== ITERATION GUIDELINES ===
1. Analyze the original design above
2. Apply the following feedback: ${feedback}
3. Create ${variations} different improvements based on the feedback
4. Each variation should interpret the feedback slightly differently
5. Maintain the core structure while implementing improvements
6. Follow all Superdesign guidelines

=== SUPERDESIGN SYSTEM PROMPT ===
${SUPERDESIGN_SYSTEM_PROMPT}

=== EXECUTION INSTRUCTIONS ===
1. Read and understand the original design
2. Generate ${variations} improved variations based on the feedback
3. Save each variation with the exact filenames listed above
4. Ensure each iteration is an improvement while maintaining design consistency

Please proceed to create these ${variations} improved design files now.`;

        return {
          content: [{ type: "text", text: specifications }],
        };
      }

      case "superdesign_extract_system": {
        const { image_path } = ExtractDesignSystemSchema.parse(args);
        
        if (!existsSync(image_path)) {
          return {
            content: [{ type: "text", text: `Error: Image file ${image_path} does not exist` }],
          };
        }

        const superdesignDir = getSuperdeignDirectory();
        const designSystemDir = path.join(superdesignDir, 'design_system');
        
        let specifications = `DESIGN SYSTEM EXTRACTION SPECIFICATION FOR CLAUDE CODE:

IMPORTANT: You must analyze the image and extract a design system JSON file.

=== EXTRACTION PARAMETERS ===
- Image path: ${image_path}
- Output location: ${designSystemDir}/design-system.json

=== EXTRACTION GUIDELINES ===
Analyze the screenshot/image and extract:
1. Color palette (primary, secondary, neutrals)
2. Typography rules (font families, sizes, weights, line heights)
3. Spacing system (margin/padding values)
4. Layout structure (grid system, containers)
5. Component styles (buttons, inputs, cards, etc.)
6. Visual effects (shadows, borders, radius values)

=== OUTPUT FORMAT ===
Create a JSON file with this structure:
{
  "colors": {
    "primary": {...},
    "secondary": {...},
    "neutrals": {...}
  },
  "typography": {
    "fontFamilies": {...},
    "sizes": {...},
    "weights": {...}
  },
  "spacing": {...},
  "components": {
    "buttons": {...},
    "inputs": {...},
    ...
  },
  "effects": {...}
}

=== EXECUTION INSTRUCTIONS ===
1. Analyze the image at ${image_path}
2. Extract ONLY design patterns, not content
3. Create a reusable design system
4. Save as ${designSystemDir}/design-system.json
5. If file exists, create design-system_2.json, etc.

Please proceed to analyze the image and create the design system JSON file now.`;

        return {
          content: [{ type: "text", text: specifications }],
        };
      }

      case "superdesign_list": {
        const { workspace_path } = ListDesignsSchema.parse(args);
        
        try {
          const superdesignDir = getSuperdeignDirectory(workspace_path);
          const designIterationsDir = path.join(superdesignDir, 'design_iterations');
          const designSystemDir = path.join(superdesignDir, 'design_system');

          const designFiles = await glob('*.{html,svg}', { cwd: designIterationsDir });
          const systemFiles = await glob('*.json', { cwd: designSystemDir });

          let result = `Superdesign workspace: ${superdesignDir}\n\n`;
          
          if (designFiles.length > 0) {
            result += `Design iterations (${designFiles.length}):\n`;
            designFiles.forEach(file => {
              result += `  - ${file}\n`;
            });
          } else {
            result += "No design iterations found.\n";
          }

          result += "\n";

          if (systemFiles.length > 0) {
            result += `Design systems (${systemFiles.length}):\n`;
            systemFiles.forEach(file => {
              result += `  - ${file}\n`;
            });
          } else {
            result += "No design systems found.\n";
          }

          return {
            content: [{ type: "text", text: result }],
          };
        } catch (error: any) {
          return {
            content: [{ type: "text", text: `Error listing designs: ${error.message}` }],
          };
        }
      }

      case "superdesign_gallery": {
        const { workspace_path } = GallerySchema.parse(args);
        
        try {
          const superdesignDir = getSuperdeignDirectory(workspace_path);
          const designIterationsDir = path.join(superdesignDir, 'design_iterations');
          
          if (!existsSync(designIterationsDir)) {
            return {
              content: [{ type: "text", text: "No design iterations found. Generate some designs first using superdesign_generate." }],
            };
          }

          const designFiles = await glob('*.{html,svg}', { cwd: designIterationsDir });
          
          if (designFiles.length === 0) {
            return {
              content: [{ type: "text", text: "No design files found in design_iterations directory." }],
            };
          }

          const galleryPath = path.join(superdesignDir, 'gallery.html');
          
          // Generate gallery HTML
          const galleryHtml = generateGalleryHTML(designFiles, superdesignDir);
          
          let specifications = `GALLERY GENERATION SPECIFICATION FOR CLAUDE CODE:

IMPORTANT: You must create a gallery HTML file to view all designs in a browser.

=== GALLERY PARAMETERS ===
- Gallery file: ${galleryPath}
- Design files found: ${designFiles.length}
- Directory: ${designIterationsDir}

=== FILES TO DISPLAY ===
${designFiles.map((file, index) => `${index + 1}. ${file}`).join('\n')}

=== GALLERY HTML CONTENT ===
${galleryHtml}

=== EXECUTION INSTRUCTIONS ===
1. Create the gallery file at: ${galleryPath}
2. Write the gallery HTML content above to the file
3. **AUTOMATICALLY OPEN** the gallery in the default browser using: open "${galleryPath}"
4. The gallery will show all design variations with enhanced MCP integration
5. Gallery features: smart refresh, auto-refresh, dark mode, file metadata display

Please proceed to create the gallery file and **automatically open it in the browser**.`;

          return {
            content: [{ type: "text", text: specifications }],
          };
        } catch (error: any) {
          return {
            content: [{ type: "text", text: `Error generating gallery: ${error.message}` }],
          };
        }
      }

      case "superdesign_delete": {
        const { filename, workspace_path } = DeleteDesignSchema.parse(args);
        
        try {
          const superdesignDir = getSuperdeignDirectory(workspace_path);
          const designIterationsDir = path.join(superdesignDir, 'design_iterations');
          const filePath = path.join(designIterationsDir, filename);
          
          if (!existsSync(filePath)) {
            return {
              content: [{ type: "text", text: `Error: Design file ${filename} does not exist` }],
            };
          }
          
          // Delete the file
          unlinkSync(filePath);
          
          // Update metadata
          const metadata = loadMetadata(superdesignDir);
          const filteredMetadata = metadata.filter(m => m.fileName !== filename);
          saveMetadata(superdesignDir, filteredMetadata);
          
          return {
            content: [{ type: "text", text: `Successfully deleted ${filename}` }],
          };
        } catch (error: any) {
          return {
            content: [{ type: "text", text: `Error deleting design: ${error.message}` }],
          };
        }
      }

      case "superdesign_cleanup": {
        const { workspace_path, max_age_days, max_count, dry_run } = CleanupSchema.parse(args);
        
        try {
          const superdesignDir = getSuperdeignDirectory(workspace_path);
          const result = performCleanup(superdesignDir, max_age_days, max_count, dry_run || false);
          
          let response = `CLEANUP RESULTS:\n\n`;
          
          if (dry_run) {
            response += `DRY RUN - No files were actually deleted\n\n`;
          }
          
          if (result.deleted.length > 0) {
            response += `Files ${dry_run ? 'to be deleted' : 'deleted'} (${result.deleted.length}):\n`;
            result.deleted.forEach(file => {
              response += `  - ${file}\n`;
            });
            response += `\n`;
          }
          
          if (result.kept.length > 0) {
            response += `Files kept (${result.kept.length}):\n`;
            result.kept.forEach(file => {
              response += `  - ${file}\n`;
            });
            response += `\n`;
          }
          
          if (result.errors.length > 0) {
            response += `Errors (${result.errors.length}):\n`;
            result.errors.forEach(error => {
              response += `  - ${error}\n`;
            });
            response += `\n`;
          }
          
          if (result.deleted.length === 0 && result.errors.length === 0) {
            response += `No files needed cleanup.\n`;
          }
          
          const settings = getCleanupSettings(superdesignDir);
          response += `\nCleanup settings:\n`;
          response += `  - Max age: ${max_age_days || settings.maxAgeDays} days\n`;
          response += `  - Max count: ${max_count || settings.maxCount} files\n`;
          response += `  - Enabled: ${settings.enabled}\n`;
          
          return {
            content: [{ type: "text", text: response }],
          };
        } catch (error: any) {
          return {
            content: [{ type: "text", text: `Error during cleanup: ${error.message}` }],
          };
        }
      }

      case "superdesign_live_gallery": {
        const { workspace_path, port } = LiveGallerySchema.parse(args);
        
        try {
          const superdesignDir = getSuperdeignDirectory(workspace_path);
          const designIterationsDir = path.join(superdesignDir, 'design_iterations');
          
          if (!existsSync(designIterationsDir)) {
            return {
              content: [{ type: "text", text: "No design iterations found. Generate some designs first using superdesign_generate." }],
            };
          }
          
          const serverPort = port || 3000;
          const serverUrl = await createLiveGalleryServer(superdesignDir, serverPort);
          
          let response = `LIVE GALLERY SERVER STARTED:

🌐 Server URL: ${serverUrl}
📁 Workspace: ${superdesignDir}
🔴 Live Updates: Enabled
📡 Port: ${serverPort}

=== FEATURES ===
✨ Real-time file watching
🔄 Auto-refresh on file changes
🌙 Dark/Light mode toggle
📱 Responsive design
🗂️ File metadata display

=== USAGE ===
1. Open ${serverUrl} in your browser
2. The gallery will automatically update when design files change
3. Use the theme toggle to switch between light and dark modes
4. Click "View Full" to open designs in new tabs
5. Use "Copy Path" to copy file paths to clipboard

=== LIVE UPDATES ===
The gallery will automatically detect:
• New design files added to design_iterations/
• Modified design files (with visual highlights)
• Deleted design files (with smooth removal)

Keep this server running to maintain live updates. The gallery will reconnect automatically if the connection is lost.

Server is now running at: ${serverUrl}`;
          
          return {
            content: [{ type: "text", text: response }],
          };
        } catch (error: any) {
          return {
            content: [{ type: "text", text: `Error starting live gallery server: ${error.message}` }],
          };
        }
      }

      case "superdesign_check_files": {
        const { workspace_path, manifest } = CheckFilesSchema.parse(args);
        
        try {
          const superdesignDir = getSuperdeignDirectory(workspace_path);
          const designIterationsDir = path.join(superdesignDir, 'design_iterations');
          
          if (!existsSync(designIterationsDir)) {
            return {
              content: [{ type: "text", text: JSON.stringify({ hasChanges: false, changes: [], error: "No design iterations directory found" }) }],
            };
          }
          
          const result = checkFileChanges(superdesignDir, manifest);
          
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (error: any) {
          return {
            content: [{ type: "text", text: JSON.stringify({ hasChanges: false, changes: [], error: error.message }) }],
          };
        }
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error parsing arguments: ${error.message}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});