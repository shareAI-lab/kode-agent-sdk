import { generateAgentId } from '../../../src/utils/agent-id';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('AgentId');

// Crockford Base32 字符集（用于时间戳编码）
const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

runner
  .test('生成的AgentId唯一且包含时间戳', async () => {
    const id1 = generateAgentId();
    const id2 = generateAgentId();

    // 验证唯一性
    expect.toEqual(id1 !== id2, true);

    // 验证格式：agt-{时间戳10位}{随机16位}
    expect.toContain(id1, 'agt-');
    expect.toEqual(id1.length, 4 + 10 + 16); // agt- + 时间戳 + 随机

    // 验证时间戳部分（前10位）是有效的 Crockford Base32
    const timePart = id1.slice(4, 14);
    for (const char of timePart) {
      expect.toEqual(
        CROCKFORD32.includes(char),
        true,
        `时间戳字符 '${char}' 不是有效的 Crockford Base32`
      );
    }
  });

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
