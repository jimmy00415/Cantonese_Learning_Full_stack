/**
 * Cultural Context Service
 * Provides Cantonese cultural knowledge, slang explanations, and colloquial suggestions
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load cultural database
let cultureData = null;

function loadCultureData() {
  if (cultureData) return cultureData;
  
  try {
    const dataPath = join(__dirname, '../data/cantonese-culture.json');
    const rawData = readFileSync(dataPath, 'utf8');
    cultureData = JSON.parse(rawData);
    console.log(`Cultural database loaded: ${cultureData.slang.length} slang entries, ${cultureData.idioms.length} idioms`);
    return cultureData;
  } catch (err) {
    console.error('Failed to load cultural database:', err.message);
    return { slang: [], codeSwitch: [], idioms: [], cafeSlang: [], formalToColloquial: {} };
  }
}

/**
 * Find slang terms in the given text
 * @param {string} text - User's input text
 * @returns {Array} - Array of matching slang entries
 */
export function findSlang(text) {
  const data = loadCultureData();
  return data.slang.filter(s => text.includes(s.term));
}

/**
 * Explain a specific slang term
 * @param {string} term - The term to explain
 * @returns {string|null} - Explanation or null if not found
 */
export function explainTerm(term) {
  const data = loadCultureData();
  const entry = data.slang.find(s => s.term === term);
  if (!entry) return null;
  
  let explanation = `「${entry.term}」(${entry.pinyin}) 嘅意思係：${entry.meaning}。`;
  if (entry.context) {
    explanation += `${entry.context}。`;
  }
  if (entry.politeAlternative) {
    explanation += `比較禮貌嘅講法：「${entry.politeAlternative}」。`;
  }
  return explanation;
}

/**
 * Find code-switching patterns in text
 * @param {string} text - User's input text
 * @returns {Array} - Array of detected code-switch patterns
 */
export function findCodeSwitch(text) {
  const data = loadCultureData();
  const lowerText = text.toLowerCase();
  return data.codeSwitch.filter(c => lowerText.includes(c.pattern.toLowerCase()));
}

/**
 * Get cafe/restaurant slang explanations
 * @param {string} text - User's input text
 * @returns {Array} - Array of matching cafe slang
 */
export function findCafeSlang(text) {
  const data = loadCultureData();
  return data.cafeSlang.filter(c => text.includes(c.term));
}

/**
 * Suggest colloquial alternatives for formal text
 * @param {string} text - User's input text
 * @returns {Array} - Array of suggestions {formal, colloquial}
 */
export function suggestColloquial(text) {
  const data = loadCultureData();
  const suggestions = [];
  
  for (const [formal, colloquial] of Object.entries(data.formalToColloquial)) {
    if (text.includes(formal)) {
      suggestions.push({
        formal,
        colloquial,
        context: `「${formal}」嘅口語講法可以係「${colloquial}」`
      });
    }
  }
  
  return suggestions;
}

/**
 * Find matching idioms in text
 * @param {string} text - User's input text
 * @returns {Array} - Array of matching idioms
 */
export function findIdioms(text) {
  const data = loadCultureData();
  return data.idioms.filter(i => text.includes(i.idiom));
}

/**
 * Get cultural context for a conversation turn
 * Used to enhance LLM prompts with relevant cultural knowledge
 * @param {string} text - User's input text
 * @returns {object} - Cultural context object
 */
export function getCulturalContext(text) {
  const slangMatches = findSlang(text);
  const codeSwitch = findCodeSwitch(text);
  const cafeSlang = findCafeSlang(text);
  const colloquialSuggestions = suggestColloquial(text);
  const idioms = findIdioms(text);
  
  const hasContent = slangMatches.length > 0 || codeSwitch.length > 0 || 
                     cafeSlang.length > 0 || colloquialSuggestions.length > 0 || 
                     idioms.length > 0;
  
  return {
    hasContent,
    slang: slangMatches,
    codeSwitch,
    cafeSlang,
    colloquialSuggestions,
    idioms,
    summary: hasContent ? generateContextSummary(slangMatches, codeSwitch, cafeSlang, colloquialSuggestions, idioms) : null
  };
}

/**
 * Generate a summary string for LLM context injection
 */
function generateContextSummary(slang, codeSwitch, cafeSlang, colloquial, idioms) {
  const parts = [];
  
  if (slang.length > 0) {
    parts.push(`用咗俚語：${slang.map(s => s.term).join('、')}`);
  }
  
  if (codeSwitch.length > 0) {
    parts.push(`中英混合：${codeSwitch.map(c => c.pattern).join('、')}`);
  }
  
  if (cafeSlang.length > 0) {
    parts.push(`茶餐廳術語：${cafeSlang.map(c => c.term).join('、')}`);
  }
  
  if (colloquial.length > 0 && colloquial.length <= 3) {
    parts.push(`書面語：${colloquial.map(c => c.formal).join('、')} → 可以用口語「${colloquial.map(c => c.colloquial).join('、')}」`);
  }
  
  if (idioms.length > 0) {
    parts.push(`成語/俗語：${idioms.map(i => i.idiom).join('、')}`);
  }
  
  return parts.join('；');
}

/**
 * Generate correction prompt based on cultural context
 * @param {string} utterance - User's utterance to correct
 * @returns {string} - Correction prompt for LLM
 */
export function generateCorrectionPrompt(utterance) {
  const context = getCulturalContext(utterance);
  
  let prompt = `作為廣東話老師，詳細分析以下句子：「${utterance}」\n\n`;
  
  if (context.hasContent) {
    prompt += `## 文化背景資料\n${context.summary}\n\n`;
  }
  
  prompt += `請提供：
1. **發音評估**：如果有明顯錯誤或不自然嘅發音
2. **文法檢查**：句子結構有冇問題
3. **用詞建議**：有冇更地道嘅講法
4. **正確版本**：改正後嘅完整句子

格式：
📝 你講：[原句]
✅ 建議：[改正版本]
💡 解釋：[簡短說明每個改動嘅原因]`;
  
  return prompt;
}

export default {
  findSlang,
  explainTerm,
  findCodeSwitch,
  findCafeSlang,
  suggestColloquial,
  findIdioms,
  getCulturalContext,
  generateCorrectionPrompt
};
