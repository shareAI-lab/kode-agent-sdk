import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ObservationEnvelope } from '../../types';
import {
  buildPersistedObservationRunView,
  filterPersistedObservationEnvelopes,
} from '../reader';
import { applyObservationRetention } from '../retention';
import type {
  ObservationPruneResult,
  ObservationQueryBackend,
  ObservationRetentionPolicy,
  PersistedObservationListOptions,
} from '../types';

export class JSONStoreObservationBackend implements ObservationQueryBackend {
  constructor(private readonly baseDir: string) {}

  async append(envelope: ObservationEnvelope): Promise<void> {
    const filePath = this.getObservationFilePath(envelope.observation.agentId);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.appendFile(filePath, `${JSON.stringify(envelope)}\n`, 'utf-8');
  }

  async list(opts?: PersistedObservationListOptions): Promise<ObservationEnvelope[]> {
    const envelopes = await this.loadEnvelopes(opts);
    return filterPersistedObservationEnvelopes(envelopes, opts);
  }

  async getRun(runId: string) {
    const envelopes = await this.loadEnvelopes({ runId });
    return buildPersistedObservationRunView(envelopes, runId);
  }

  async prune(policy?: ObservationRetentionPolicy): Promise<ObservationPruneResult> {
    if (!policy) {
      const retained = (await this.loadEnvelopes()).length;
      return { deleted: 0, retained };
    }

    const files = await this.listObservationFiles();
    let deleted = 0;
    let retained = 0;

    for (const filePath of files) {
      const envelopes = await this.readObservationFile(filePath);
      const next = applyObservationRetention(envelopes, policy);
      deleted += next.result.deleted;
      retained += next.result.retained;

      if (next.result.deleted === 0) {
        continue;
      }

      if (next.envelopes.length === 0) {
        await fs.promises.rm(filePath, { force: true });
        continue;
      }

      await this.writeObservationFile(filePath, next.envelopes);
    }

    return { deleted, retained };
  }

  private async loadEnvelopes(opts?: PersistedObservationListOptions): Promise<ObservationEnvelope[]> {
    const filePaths = await this.resolveObservationFiles(opts);
    const loaded = await Promise.all(filePaths.map((filePath) => this.readObservationFile(filePath)));
    return loaded.flat();
  }

  private async resolveObservationFiles(opts?: PersistedObservationListOptions): Promise<string[]> {
    const agentIds = new Set<string>();
    if (opts?.agentId) {
      agentIds.add(opts.agentId);
    }
    if (opts?.agentIds) {
      for (const agentId of opts.agentIds) {
        agentIds.add(agentId);
      }
    }

    if (agentIds.size > 0) {
      return [...agentIds].map((agentId) => this.getObservationFilePath(agentId));
    }

    return this.listObservationFiles();
  }

  private getObservationFilePath(agentId: string): string {
    return path.join(this.baseDir, '_observations', `${this.hashAgentId(agentId)}.jsonl`);
  }

  private hashAgentId(agentId: string): string {
    return createHash('sha256').update(agentId).digest('hex');
  }

  private async listObservationFiles(): Promise<string[]> {
    const dir = path.join(this.baseDir, '_observations');
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => path.join(dir, entry.name));
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async readObservationFile(filePath: string): Promise<ObservationEnvelope[]> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ObservationEnvelope);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async writeObservationFile(filePath: string, envelopes: ObservationEnvelope[]): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    const payload = `${envelopes.map((envelope) => JSON.stringify(envelope)).join('\n')}\n`;
    await fs.promises.writeFile(tempPath, payload, 'utf-8');
    await fs.promises.rename(tempPath, filePath);
  }
}
