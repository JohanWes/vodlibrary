const https = require('https');

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
    console.log('[LLM] Starting advanced search with query:', query);
    console.log('[LLM] Found', videosWithMetadata.length, 'videos with metadata');
    
    if (!this.isAvailable()) {
      throw new Error('OpenRouter API key not configured');
    }

    if (!videosWithMetadata || videosWithMetadata.length === 0) {
      console.warn('[LLM] No videos with metadata available');
      return [];
    }

    // Prepare metadata for LLM analysis
    const metadataPrompt = this.buildMetadataPrompt(query, videosWithMetadata);
    console.log('[LLM] Generated prompt (length:', metadataPrompt.length, 'chars)');
    
    const requestData = {
      model: this.model,
      messages: [
        {
          role: 'user',
          content: metadataPrompt
        }
      ],
      temperature: 0.1,
      max_tokens: 4000
    };
    
    console.log('[LLM] API Request:', {
      model: requestData.model,
      temperature: requestData.temperature,
      max_tokens: requestData.max_tokens,
      promptLength: metadataPrompt.length
    });
    
    try {
      const startTime = Date.now();
      const response = await this.makeRequest('/chat/completions', requestData);
      const endTime = Date.now();
      
      console.log('[LLM] API Response received in', endTime - startTime, 'ms');
      console.log('[LLM] Full API Response:', JSON.stringify(response, null, 2));

      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        console.error('[LLM] No content in response');
        console.error('[LLM] Response structure:', response);
        throw new Error('No response content from LLM');
      }

      console.log('[LLM] Response content:', content);
      console.log('[LLM] Response content length:', content.length);

      const results = this.parseSearchResults(content, videosWithMetadata);
      console.log('[LLM] Parsed', results.length, 'matching videos');
      
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

    return `You are analyzing World of Warcraft Mythic+ dungeon runs to find matches for user queries.

CRITICAL: You MUST return ONLY valid JSON. No markdown, no explanations, no other text whatsoever.

User Query: "${query}"

Available Videos:
${videoEntries}

Instructions:
- Match dungeon names from video titles (e.g., "Priory" = "Algeth'ar Academy", "CM" = "Cinderbrew Meadery")
- Analyze death timestamps for timing-based queries (e.g., "2-3 minutes" = 120-180 seconds)
- Look for player names mentioned in deaths array
- Consider key levels and run outcomes from titles ("+20", "Abandoned", "Completed")
- Time references: "early" = 0-300 seconds, "middle" = 300-900 seconds, "late" = 900+ seconds

RESPONSE FORMAT - FOLLOW EXACTLY:
- Return ONLY a JSON array, nothing else
- Use the exact date and duration values provided for each video
- DO NOT include markdown, explanations, or any text outside the JSON
- Start response with [ and end with ]

Required Format: [{"date": "2025-07-10T19:47:14.000Z", "duration": 428.5, "reason": "brief explanation"}]
If no matches: []

Examples:
CORRECT: [{"date": "2025-07-06T13:22:52.000Z", "duration": 958.1, "reason": "Cinderbrew Meadery run with 5 deaths"}]
INCORRECT: **Analysis:** The videos show... [{"date": "...", "duration": ...}]

Your response (JSON only):`;
  }

  /**
   * Parse LLM response and match to videos
   */
  parseSearchResults(content, videosWithMetadata) {
    console.log('[LLM] Parsing search results from response');
    
    try {
      // Try multiple parsing strategies for robustness
      let matches = null;
      
      // Strategy 1: Look for JSON array in the response
      const jsonMatch = content.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        console.log('[LLM] Found JSON array pattern:', jsonMatch[0]);
        try {
          matches = JSON.parse(jsonMatch[0]);
          console.log('[LLM] Successfully parsed JSON array');
        } catch (parseError) {
          console.warn('[LLM] Failed to parse matched JSON:', parseError.message);
        }
      }
      
      // Strategy 2: Look for JSON array with markdown code blocks
      if (!matches) {
        const codeBlockMatch = content.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
        if (codeBlockMatch) {
          console.log('[LLM] Found JSON in code block:', codeBlockMatch[1]);
          try {
            matches = JSON.parse(codeBlockMatch[1]);
            console.log('[LLM] Successfully parsed JSON from code block');
          } catch (parseError) {
            console.warn('[LLM] Failed to parse JSON from code block:', parseError.message);
          }
        }
      }
      
      // Strategy 3: Try to parse the entire response as JSON
      if (!matches) {
        try {
          matches = JSON.parse(content.trim());
          console.log('[LLM] Successfully parsed entire response as JSON');
        } catch (parseError) {
          console.warn('[LLM] Failed to parse entire response as JSON:', parseError.message);
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

      console.log('[LLM] Found', matches.length, 'potential matches');

      // Match the LLM results back to our video objects
      const results = [];
      for (const [index, match] of matches.entries()) {
        console.log(`[LLM] Processing match ${index + 1}:`, match);
        
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
          console.log(`[LLM] Successfully matched video:`, video.title);
          results.push({
            ...video,
            searchReason: match.reason || 'LLM match'
          });
        } else {
          console.warn(`[LLM] Could not find video with date=${match.date}, duration=${match.duration}`);
        }
      }

      console.log('[LLM] Final results:', results.length, 'matched videos');
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
    console.log(`[LLM] Searching for video with date=${targetDate}, duration=${targetDuration}`);
    console.log(`[LLM] Available videos:`, videos.length);
    
    const matches = [];
    
    for (const [index, video] of videos.entries()) {
      try {
        const metadata = JSON.parse(video.metadata);
        const videoDate = metadata.start ? new Date(metadata.start).toISOString() : video.added_date;
        const videoDuration = metadata.duration || 0;
        
        console.log(`[LLM] Video ${index + 1}: ${video.title}`);
        console.log(`[LLM]   Date: ${videoDate} (target: ${targetDate})`);
        console.log(`[LLM]   Duration: ${videoDuration} (target: ${targetDuration})`);
        
        // Allow small duration differences (within 5 seconds)
        const durationMatch = Math.abs(videoDuration - targetDuration) <= 5;
        const dateMatch = videoDate === targetDate;
        
        console.log(`[LLM]   Date match: ${dateMatch}, Duration match: ${durationMatch}`);
        
        if (dateMatch && durationMatch) {
          console.log(`[LLM] ✓ Found matching video: ${video.title}`);
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