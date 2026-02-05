const https = require('https');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

function debugLog(...args) {
  if (LOG_LEVEL === 'debug') {
    console.log(...args);
  }
}

/**
 * OpenRouter API integration for advanced video search
 */
class OpenRouterClient {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    this.model = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-preview-05-20:thinking';
    this.baseUrl = 'https://openrouter.ai/api/v1';
    
    if (!this.apiKey) {
      console.warn('OpenRouter API key not configured. Advanced search will be disabled.');
    }
  }

  /**
   * Check if the LLM service is available
   */
  isAvailable() {
    return !!this.apiKey;
  }

  /**
   * Make a request to OpenRouter API
   */
  async makeRequest(endpoint, data) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(data);
      
      const options = {
        hostname: 'openrouter.ai',
        port: 443,
        path: `/api/v1${endpoint}`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'HTTP-Referer': 'https://vodlibrary.local',
          'X-Title': 'VODlibrary Advanced Search'
        }
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          try {
            const response = JSON.parse(responseData);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else {
              reject(new Error(`API request failed: ${res.statusCode} - ${response.error?.message || responseData}`));
            }
          } catch (error) {
            reject(new Error(`Failed to parse API response: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`));
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Search videos using LLM analysis of metadata
   */
  async searchVideos(query, videosWithMetadata) {
    debugLog('[LLM] Starting advanced search with query:', query);
    debugLog('[LLM] Found', videosWithMetadata.length, 'videos with metadata');

    if (!this.isAvailable()) {
      throw new Error('OpenRouter API key not configured');
    }

    if (!videosWithMetadata || videosWithMetadata.length === 0) {
      console.warn('[LLM] No videos with metadata available');
      return [];
    }

    // Helper function to extract date from video for sorting
    const getVideoDate = (video) => {
      try {
        const metadata = JSON.parse(video.metadata);
        return metadata.start ? new Date(metadata.start).getTime() : new Date(video.added_date).getTime();
      } catch {
        return new Date(video.added_date).getTime();
      }
    };

    // Sort videos by date (newest first) and limit to latest 50
    const sortedVideos = videosWithMetadata.sort((a, b) => getVideoDate(b) - getVideoDate(a));
    const limitedVideos = sortedVideos.slice(0, 50);

    debugLog('[LLM] Limited to', limitedVideos.length, 'most recent videos for LLM analysis');

    // Prepare metadata for LLM analysis
    const metadataPrompt = this.buildMetadataPrompt(query, limitedVideos);
    debugLog('[LLM] Generated prompt (length:', metadataPrompt.length, 'chars)');
    
    const requestData = {
      model: this.model,
      messages: [
        {
          role: 'user',
          content: metadataPrompt
        }
      ],
      temperature: 0.1,
      max_tokens: 8000
    };
    
    debugLog('[LLM] API Request:', {
      model: requestData.model,
      temperature: requestData.temperature,
      max_tokens: requestData.max_tokens,
      promptLength: metadataPrompt.length
    });
    
    try {
      const startTime = Date.now();
      const response = await this.makeRequest('/chat/completions', requestData);
      const endTime = Date.now();
      
      debugLog('[LLM] API Response received in', endTime - startTime, 'ms');

      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        console.error('[LLM] No content in response');
        console.error('[LLM] Response structure:', response);
        throw new Error('No response content from LLM');
      }

      debugLog('[LLM] Response content length:', content.length);

      const results = this.parseSearchResults(content, limitedVideos);
      debugLog('[LLM] Parsed', results.length, 'matching videos');
      
      return results;
    } catch (error) {
      console.error('[LLM] Search error:', error);
      console.error('[LLM] Error details:', {
        message: error.message,
        stack: error.stack,
        query: query,
        videosCount: videosWithMetadata.length
      });
      throw error;
    }
  }

  /**
   * Build the prompt for LLM analysis
   */
  buildMetadataPrompt(query, videosWithMetadata) {
    const videoEntries = videosWithMetadata.map((video, index) => {
      let metadata;
      try {
        metadata = JSON.parse(video.metadata);
      } catch (error) {
        return null; // Skip videos with invalid metadata
      }

      // Extract key identifiers for response matching
      const date = metadata.start ? new Date(metadata.start).toISOString() : video.added_date;
      const duration = metadata.duration || 0;
      
      // Extract only essential data: deaths and duration
      const deaths = metadata.deaths || [];
      const simplifiedDeaths = deaths.map(death => ({
        name: death.name,
        timestamp: Math.round(death.timestamp * 10) / 10 // Round to 1 decimal
      }));

      return `Video ${index + 1}: title="${video.title}", date=${date}, duration=${duration}
Deaths: ${JSON.stringify(simplifiedDeaths)}`;
    }).filter(Boolean).join('\n\n');

    return `You are analyzing World of Warcraft Mythic+ dungeon/raid runs to find matches for user queries.

CRITICAL FORMATTING RULES:
- Return ONLY raw JSON array, no other text
- NO markdown code blocks (no \`\`\`json)
- NO explanations or analysis text
- Start immediately with [ character
- End with ] character
- Nothing before or after the JSON

User Query: "${query}"

Available Videos:
${videoEntries}

Analysis Instructions:
- Match dungeon names from titles (e.g., "Priory" = "Algeth'ar Academy", "CM" = "Cinderbrew Meadery") 
- For timing queries: "early" = 0-300s, "2-3 minutes" = 120-180s, "late" = 900s+
- Match player names in deaths array (consider name variations like "Evandis"/"Evandeux")
- Check if player was first to die by comparing timestamps
- Consider key levels and outcomes from titles

Output Format: [{"date": "EXACT_DATE_FROM_VIDEO", "duration": EXACT_DURATION, "reason": "brief explanation"}]
Empty result: []

RESPONSE (start with [ immediately):`;
  }

  /**
   * Parse LLM response and match to videos
   */
  parseSearchResults(content, videosWithMetadata) {
    debugLog('[LLM] Parsing search results from response');
    
    try {
      // Try multiple parsing strategies for robustness
      let matches = null;
      
      // Strategy 1: Look for JSON array in the response
      const jsonMatch = content.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        debugLog('[LLM] Found JSON array pattern');
        try {
          matches = JSON.parse(jsonMatch[0]);
          debugLog('[LLM] Successfully parsed JSON array');
        } catch (parseError) {
          console.warn('[LLM] Failed to parse matched JSON:', parseError.message);
        }
      }
      
      // Strategy 2: Look for JSON array with markdown code blocks (multiple patterns)
      if (!matches) {
        const codeBlockPatterns = [
          /```(?:json)?\s*(\[[\s\S]*?\])\s*```/,
          /```(\[[\s\S]*?\])/,
          /```json\s*(\[[\s\S]*?\])/,
          /```\s*(\[[\s\S]*?\])\s*```/
        ];
        
        for (const pattern of codeBlockPatterns) {
          const codeBlockMatch = content.match(pattern);
          if (codeBlockMatch) {
            debugLog('[LLM] Found JSON in code block');
            try {
              matches = JSON.parse(codeBlockMatch[1]);
              debugLog('[LLM] Successfully parsed JSON from code block');
              break;
            } catch (parseError) {
              console.warn('[LLM] Failed to parse JSON from code block:', parseError.message);
            }
          }
        }
      }
      
      // Strategy 3: Try to parse the entire response as JSON
      if (!matches) {
        try {
          matches = JSON.parse(content.trim());
          debugLog('[LLM] Successfully parsed entire response as JSON');
        } catch (parseError) {
          console.warn('[LLM] Failed to parse entire response as JSON:', parseError.message);
        }
      }
      
      // Strategy 4: Handle truncated JSON by attempting to complete it
      if (!matches && content.includes('[') && !content.includes(']')) {
        debugLog('[LLM] Attempting to fix truncated JSON response');
        try {
          // Try to close the JSON array if it was cut off
          let fixedContent = content.trim();
          if (fixedContent.endsWith(',')) {
            fixedContent = fixedContent.slice(0, -1); // Remove trailing comma
          }
          if (!fixedContent.endsWith(']')) {
            fixedContent += ']'; // Add closing bracket
          }
          
          // Try to extract JSON from the fixed content
          const jsonMatch = fixedContent.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            matches = JSON.parse(jsonMatch[0]);
            debugLog('[LLM] Successfully parsed truncated JSON after fixing');
          }
        } catch (parseError) {
          console.warn('[LLM] Failed to parse truncated JSON:', parseError.message);
        }
      }
      
      if (!matches) {
        console.error('[LLM] No valid JSON found in response after all strategies');
        console.error('[LLM] Raw response content:', content);
        console.error('[LLM] Response analysis:', {
          length: content.length,
          hasSquareBrackets: content.includes('[') && content.includes(']'),
          hasCodeBlocks: content.includes('```'),
          startsWithBracket: content.trim().startsWith('['),
          endsWithBracket: content.trim().endsWith(']')
        });
        return [];
      }

      if (!Array.isArray(matches)) {
        console.error('[LLM] Parsed result is not an array:', typeof matches, matches);
        return [];
      }

      debugLog('[LLM] Found', matches.length, 'potential matches');

      // Match the LLM results back to our video objects
      const results = [];
      for (const [index, match] of matches.entries()) {
        debugLog(`[LLM] Processing match ${index + 1}:`, match);
        
        if (!match || typeof match !== 'object') {
          console.warn(`[LLM] Invalid match object at index ${index}:`, match);
          continue;
        }
        
        if (!match.date || !match.duration) {
          console.warn(`[LLM] Missing date/duration in match ${index}:`, match);
          continue;
        }
        
        const video = this.findVideoByDateAndDuration(
          videosWithMetadata, 
          match.date, 
          match.duration
        );
        
        if (video) {
          debugLog(`[LLM] Successfully matched video:`, video.title);
          results.push({
            ...video,
            searchReason: match.reason || 'LLM match'
          });
        } else {
          console.warn(`[LLM] Could not find video with date=${match.date}, duration=${match.duration}`);
        }
      }

      debugLog('[LLM] Final results:', results.length, 'matched videos');
      return results;
    } catch (error) {
      console.error('[LLM] Error parsing LLM response:', error);
      console.error('[LLM] Error stack:', error.stack);
      console.error('[LLM] Raw response:', content);
      return [];
    }
  }

  /**
   * Find video by date and duration identifiers
   */
  findVideoByDateAndDuration(videos, targetDate, targetDuration) {
    debugLog(`[LLM] Searching for video with date=${targetDate}, duration=${targetDuration}`);
    debugLog(`[LLM] Available videos:`, videos.length);
    
    const matches = [];
    
    for (const [index, video] of videos.entries()) {
      try {
        const metadata = JSON.parse(video.metadata);
        const videoDate = metadata.start ? new Date(metadata.start).toISOString() : video.added_date;
        const videoDuration = metadata.duration || 0;
        
        debugLog(`[LLM] Video ${index + 1}: ${video.title}`);
        debugLog(`[LLM]   Date: ${videoDate} (target: ${targetDate})`);
        debugLog(`[LLM]   Duration: ${videoDuration} (target: ${targetDuration})`);
        
        // Allow small duration differences (within 5 seconds)
        const durationMatch = Math.abs(videoDuration - targetDuration) <= 5;
        const dateMatch = videoDate === targetDate;
        
        debugLog(`[LLM]   Date match: ${dateMatch}, Duration match: ${durationMatch}`);
        
        if (dateMatch && durationMatch) {
          debugLog(`[LLM] ✓ Found matching video: ${video.title}`);
          matches.push(video);
        }
      } catch (error) {
        console.warn(`[LLM] Error parsing metadata for video ${video.title}:`, error.message);
      }
    }
    
    if (matches.length === 0) {
      console.warn(`[LLM] No matching videos found for date=${targetDate}, duration=${targetDuration}`);
    } else if (matches.length > 1) {
      console.warn(`[LLM] Multiple matching videos found (${matches.length}), returning first match`);
    }
    
    return matches[0] || null;
  }
}

module.exports = OpenRouterClient;
