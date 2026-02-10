/**
 * Extractable Moment Detector
 *
 * Detects patterns in conversation that indicate a skill could be extracted.
 */

export interface DetectionResult {
  /** Whether an extractable moment was detected */
  detected: boolean;
  /** Confidence score (0-100) */
  confidence: number;
  /** Type of pattern detected */
  patternType: 'problem-solution' | 'technique' | 'workaround' | 'optimization' | 'best-practice';
  /** Suggested trigger keywords */
  suggestedTriggers: string[];
  /** Reason for detection */
  reason: string;
}

/**
 * Patterns that indicate a skill might be extractable.
 * Supports English, Chinese, Korean, Japanese, and Spanish.
 */
const DETECTION_PATTERNS = [
  // Problem-Solution patterns
  {
    type: 'problem-solution' as const,
    patterns: [
      // English
      /the (?:issue|problem|bug|error) was (?:caused by|due to|because)/i,
      /(?:fixed|resolved|solved) (?:the|this) (?:by|with|using)/i,
      /the (?:solution|fix|answer) (?:is|was) to/i,
      /(?:here's|here is) (?:how|what) (?:to|you need to)/i,
      // Chinese (问题解决)
      /(?:问题|错误|bug|异常)(?:是|的原因是|出在)/,
      /(?:解决|修复|修正)(?:了|这个|该)(?:问题|错误|bug)/,
      /(?:解决方案|解决办法|修复方法)(?:是|为)/,
      /(?:这样|这里)(?:可以|能够)(?:解决|修复)/,
      // Korean (문제 해결)
      /(?:문제|오류|버그|에러)(?:는|의 원인은|가)/,
      /(?:해결|수정|고침)(?:했|됨|방법)/,
      /(?:해결책|해결 방법|수정 방법)(?:은|는|이)/,
      /(?:이렇게|이 방법으로) (?:해결|수정)(?:할 수 있|됩니다)/,
      // Japanese (問題解決)
      /(?:問題|エラー|バグ|不具合)(?:は|の原因は|が)/,
      /(?:解決|修正|直し)(?:した|できた|方法)/,
      /(?:解決策|解決方法|修正方法)(?:は|として)/,
      /(?:こうすれば|この方法で)(?:解決|修正)(?:できます|します)/,
      // Spanish (solución de problemas)
      /(?:el|la) (?:problema|error|bug|fallo) (?:era|fue|es) (?:causado por|debido a|porque)/i,
      /(?:solucioné|resolví|arreglé|corregí) (?:el|este|la) (?:problema|error|bug)/i,
      /(?:la solución|el arreglo|la corrección) (?:es|fue|era)/i,
      /(?:así es como|aquí está cómo) (?:se puede|puedes|hay que)/i,
    ],
    confidence: 80,
  },
  // Technique patterns
  {
    type: 'technique' as const,
    patterns: [
      // English
      /(?:a|the) (?:better|good|proper|correct) (?:way|approach|method) (?:is|to)/i,
      /(?:you should|we should|it's better to) (?:always|never|usually)/i,
      /(?:the trick|the key|the secret) (?:is|here is)/i,
      // Chinese (技巧方法)
      /(?:更好|正确|合适)的(?:方法|方式|做法)(?:是|为)/,
      /(?:应该|最好|建议)(?:总是|永远不要|通常)/,
      /(?:技巧|关键|诀窍|窍门)(?:是|在于)/,
      // Korean (기술 방법)
      /(?:더 좋은|올바른|적절한) (?:방법|방식|접근법)(?:은|는|이)/,
      /(?:항상|절대|보통) (?:해야|하지 말아야|하는 게 좋)/,
      /(?:요령|핵심|비결)(?:은|는|이)/,
      // Japanese (技術方法)
      /(?:より良い|正しい|適切な)(?:方法|やり方|アプローチ)(?:は|として)/,
      /(?:常に|絶対に|通常)(?:すべき|してはいけない|した方がいい)/,
      /(?:コツ|ポイント|秘訣)(?:は|として)/,
      // Spanish (técnica método)
      /(?:una|la) (?:mejor|buena|correcta|apropiada) (?:forma|manera|método) (?:es|de|para)/i,
      /(?:deberías|debes|es mejor) (?:siempre|nunca|normalmente)/i,
      /(?:el truco|la clave|el secreto) (?:es|está en)/i,
    ],
    confidence: 70,
  },
  // Workaround patterns
  {
    type: 'workaround' as const,
    patterns: [
      // English
      /(?:as a|for a) workaround/i,
      /(?:temporarily|for now|until).*(?:you can|we can)/i,
      /(?:hack|trick) (?:to|for|that)/i,
      // Chinese (变通方案)
      /(?:作为|当作)(?:变通|临时)(?:方案|办法|措施)/,
      /(?:暂时|目前|临时)(?:可以|能够|先)/,
      /(?:变通|折中|权宜)(?:的|之)(?:计|办法|方案)/,
      // Korean (임시 해결책)
      /(?:임시|우회) (?:방법|해결책|대안)(?:으로|으로서)/,
      /(?:일단|당분간|임시로) (?:이렇게|이 방법으로)/,
      /(?:꼼수|트릭|편법)(?:으로|이|가)/,
      // Japanese (回避策)
      /(?:回避策|ワークアラウンド|暫定対応)(?:として|は)/,
      /(?:とりあえず|一時的に|当面)(?:は|これで)/,
      /(?:裏技|トリック|抜け道)(?:として|で|が)/,
      // Spanish (solución temporal)
      /(?:como|para) (?:un|una) (?:solución temporal|alternativa|parche)/i,
      /(?:temporalmente|por ahora|mientras tanto).*(?:puedes|se puede)/i,
      /(?:truco|hack) (?:para|que)/i,
    ],
    confidence: 60,
  },
  // Optimization patterns
  {
    type: 'optimization' as const,
    patterns: [
      // English
      /(?:to|for) (?:better|improved|faster) performance/i,
      /(?:optimize|optimizing|optimization) (?:by|with|using)/i,
      /(?:more efficient|efficiently) (?:by|to|if)/i,
      // Chinese (优化)
      /(?:为了|以便)(?:更好|更快|更高)的(?:性能|效率)/,
      /(?:优化|改进|提升)(?:通过|使用|采用)/,
      /(?:更高效|更有效率)(?:的|地)(?:方法|方式)/,
      // Korean (최적화)
      /(?:더 나은|향상된|더 빠른) (?:성능|효율)(?:을 위해|을 위한)/,
      /(?:최적화|개선|향상)(?:하려면|하기 위해|방법)/,
      /(?:더 효율적|효율적으로)(?:으로|이|하게)/,
      // Japanese (最適化)
      /(?:より良い|改善された|より速い)(?:パフォーマンス|効率)(?:のために|には)/,
      /(?:最適化|改善|向上)(?:するには|する方法|のため)/,
      /(?:より効率的|効率よく)(?:に|する|な)/,
      // Spanish (optimización)
      /(?:para|por) (?:un|una|mejor) (?:rendimiento|desempeño|eficiencia)/i,
      /(?:optimizar|optimizando|optimización) (?:con|usando|mediante)/i,
      /(?:más eficiente|eficientemente) (?:si|cuando|al)/i,
    ],
    confidence: 65,
  },
  // Best practice patterns
  {
    type: 'best-practice' as const,
    patterns: [
      // English
      /(?:best practice|best practices) (?:is|are|include)/i,
      /(?:recommended|standard|common) (?:approach|pattern|practice)/i,
      /(?:you should always|always make sure to)/i,
      // Chinese (最佳实践)
      /(?:最佳实践|最佳做法)(?:是|包括|有)/,
      /(?:推荐|标准|常见)的(?:做法|模式|实践)/,
      /(?:应该总是|一定要|务必)/,
      // Korean (모범 사례)
      /(?:모범 사례|베스트 프랙티스|권장 사항)(?:은|는|이|가)/,
      /(?:권장|표준|일반적인) (?:방법|패턴|관행)/,
      /(?:항상 해야|반드시|꼭)/,
      // Japanese (ベストプラクティス)
      /(?:ベストプラクティス|最善の方法|推奨される方法)(?:は|として|が)/,
      /(?:推奨|標準|一般的な)(?:アプローチ|パターン|やり方)/,
      /(?:必ず|常に|絶対に)(?:してください|すべき|した方がいい)/,
      // Spanish (mejores prácticas)
      /(?:la mejor práctica|las mejores prácticas|buenas prácticas) (?:es|son|incluyen)/i,
      /(?:el enfoque|patrón|práctica) (?:recomendado|estándar|común)/i,
      /(?:siempre deberías|asegúrate siempre de)/i,
    ],
    confidence: 75,
  },
];

/**
 * Keywords that often appear in extractable content.
 * Includes multilingual keywords for Chinese, Korean, Japanese, and Spanish.
 */
const TRIGGER_KEYWORDS = [
  // Technical domains (universal)
  'react', 'typescript', 'javascript', 'python', 'rust', 'go', 'node',
  'api', 'database', 'sql', 'graphql', 'rest', 'authentication', 'authorization',
  'testing', 'debugging', 'deployment', 'docker', 'kubernetes', 'ci/cd',
  'git', 'webpack', 'vite', 'eslint', 'prettier',
  // Actions (English)
  'error handling', 'state management', 'performance', 'optimization',
  'refactoring', 'migration', 'integration', 'configuration',
  // Patterns (English)
  'pattern', 'architecture', 'design', 'structure', 'convention',
  // Chinese keywords
  '错误处理', '状态管理', '性能', '优化', '重构', '迁移', '集成', '配置',
  '模式', '架构', '设计', '结构', '规范', '解决方案', '技巧', '最佳实践',
  // Korean keywords
  '오류 처리', '상태 관리', '성능', '최적화', '리팩토링', '마이그레이션', '통합', '설정',
  '패턴', '아키텍처', '설계', '구조', '규칙', '해결책', '기술', '모범 사례',
  // Japanese keywords
  'エラー処理', '状態管理', 'パフォーマンス', '最適化', 'リファクタリング', '移行', '統合', '設定',
  'パターン', 'アーキテクチャ', '設計', '構造', '規約', '解決策', 'テクニック', 'ベストプラクティス',
  // Spanish keywords
  'manejo de errores', 'gestión de estado', 'rendimiento', 'optimización',
  'refactorización', 'migración', 'integración', 'configuración',
  'patrón', 'arquitectura', 'diseño', 'estructura', 'convención', 'solución', 'técnica', 'mejores prácticas',
];

/**
 * Detect if a message contains an extractable skill moment.
 */
export function detectExtractableMoment(
  assistantMessage: string,
  userMessage?: string
): DetectionResult {
  const combined = `${userMessage || ''} ${assistantMessage}`.toLowerCase();

  let bestMatch: { type: DetectionResult['patternType']; confidence: number; reason: string } | null = null;

  // Check against detection patterns
  for (const patternGroup of DETECTION_PATTERNS) {
    for (const pattern of patternGroup.patterns) {
      if (pattern.test(assistantMessage)) {
        if (!bestMatch || patternGroup.confidence > bestMatch.confidence) {
          bestMatch = {
            type: patternGroup.type,
            confidence: patternGroup.confidence,
            reason: `Detected ${patternGroup.type} pattern`,
          };
        }
      }
    }
  }

  if (!bestMatch) {
    return {
      detected: false,
      confidence: 0,
      patternType: 'problem-solution',
      suggestedTriggers: [],
      reason: 'No extractable pattern detected',
    };
  }

  // Extract potential trigger keywords
  const suggestedTriggers: string[] = [];
  for (const keyword of TRIGGER_KEYWORDS) {
    if (combined.includes(keyword.toLowerCase())) {
      suggestedTriggers.push(keyword);
    }
  }

  // Boost confidence if multiple triggers found
  const triggerBoost = Math.min(suggestedTriggers.length * 5, 15);
  const finalConfidence = Math.min(bestMatch.confidence + triggerBoost, 100);

  return {
    detected: true,
    confidence: finalConfidence,
    patternType: bestMatch.type,
    suggestedTriggers: suggestedTriggers.slice(0, 5), // Max 5 triggers
    reason: bestMatch.reason,
  };
}

/**
 * Check if detection confidence meets threshold for prompting.
 */
export function shouldPromptExtraction(
  detection: DetectionResult,
  threshold: number = 60
): boolean {
  return detection.detected && detection.confidence >= threshold;
}

/**
 * Generate a prompt for skill extraction confirmation.
 */
export function generateExtractionPrompt(detection: DetectionResult): string {
  const typeDescriptions: Record<DetectionResult['patternType'], string> = {
    'problem-solution': 'a problem and its solution',
    'technique': 'a useful technique',
    'workaround': 'a workaround for a limitation',
    'optimization': 'an optimization approach',
    'best-practice': 'a best practice',
  };

  return `
I noticed this conversation contains ${typeDescriptions[detection.patternType]} that might be worth saving as a reusable skill.

**Confidence:** ${detection.confidence}%
**Suggested triggers:** ${detection.suggestedTriggers.join(', ') || 'None detected'}

Would you like me to extract this as a learned skill? Type \`/oh-my-claudecode:learner\` to save it, or continue with your current task.
`.trim();
}
