import { describe, expect, it } from 'vitest';
import { mcpTools, validateToolArgs } from '../src/index.js';

describe('event reward schema parity', () => {
  it('requires exactly one event rule mode and sourceEvents for chain mode', () => {
    const tool = mcpTools.find((entry) => entry.name === 'record_event_reward');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as Record<string, any>;
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ required: expect.arrayContaining(['rule']) }),
      expect.objectContaining({ required: expect.arrayContaining(['chainRule', 'sourceEvents']) }),
    ]));
  });

  it('publishes the same one-to-31-day chain window bound as runtime validation', () => {
    const schema = mcpTools.find((entry) => entry.name === 'record_event_reward')!.inputSchema as any;
    expect(schema.properties.chainRule.properties.windowSeconds.minimum).toBe(1);
    expect(schema.properties.chainRule.properties.windowSeconds.maximum).toBe(31 * 24 * 60 * 60);
  });

  it('rejects top-level owner, sensitive, and unknown fields before dispatch', () => {
    expect(() => validateToolArgs('record_event_reward', { event: {}, candidate: {}, idempotencyKey: 'x', ownerUser: 'other' })).toThrow(/UNKNOWN_FIELD/);
    expect(() => validateToolArgs('record_event_reward', { event: {}, candidate: {}, idempotencyKey: 'x', token: 'secret' })).toThrow(/UNKNOWN_FIELD/);
  });

  it('fully retires versioned names, not just from tools/list', () => {
    expect(mcpTools.some((entry) => entry.name === 'record_event_reward_v1')).toBe(false);
    expect(mcpTools.some((entry) => entry.name === 'record_event_reward_v2')).toBe(false);
    expect(mcpTools.some((entry) => entry.name === 'reverse_event_reward_v1')).toBe(false);
    expect(() => validateToolArgs('record_event_reward_v2', { event: {}, candidate: {}, idempotencyKey: 'x' })).toThrow(/TOOL_NOT_FOUND/);
    expect(() => validateToolArgs('reverse_event_reward_v1', { event: {}, idempotencyKey: 'x' })).toThrow(/TOOL_NOT_FOUND/);
  });
});
