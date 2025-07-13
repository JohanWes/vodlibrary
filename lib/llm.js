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
    if (!this.isAvailable()) {
      throw new Error('OpenRouter API key not configured');
    }

    if (!videosWithMetadata || videosWithMetadata.length === 0) {
      return [];
    }

    // Prepare metadata for LLM analysis
    const metadataPrompt = this.buildMetadataPrompt(query, videosWithMetadata);
    
    try {
      const response = await this.makeRequest('/chat/completions', {
        model: this.model,
        messages: [
          {
            role: 'user',
            content: metadataPrompt
          }
        ],
        temperature: 0.1,
        max_tokens: 2000
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('No response content from LLM');
      }

      return this.parseSearchResults(content, videosWithMetadata);
    } catch (error) {
      console.error('LLM search error:', error);
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

      // Extract key identifiers
      const date = metadata.start ? new Date(metadata.start).toISOString() : video.added_date;
      const duration = metadata.duration || 0;

      return `---
Video ${index + 1}: date=${date}, duration=${duration}
${JSON.stringify(metadata, null, 2)}`;
    }).filter(Boolean).join('\n');

    return `You are analyzing World of Warcraft video metadata to find matches for user queries.

User Query: "${query}"

Available Videos with Metadata:
${videoEntries}

Instructions:
- Analyze each video's metadata against the user query
- Look for matches in: dungeon/raid names, player names, boss encounters, deaths, keystone levels, difficulty, zones
- For Mythic+ dungeons: check zoneID, mapID, keystoneLevel, challengeModeTimeline, affixes
- For Raids: check encounterName, difficultyID, encounterID, zoneName
- For player matches: check combatants array and player names in deaths
- For boss/encounter matches: check encounterID, encounterId in timeline, and death timestamps during boss segments
- Return ONLY a JSON array of matching videos with their date and duration identifiers
- Format: [{"date": "2025-07-10T19:47:14.000Z", "duration": 428, "reason": "brief explanation"}]
- If no matches found, return: []

Response:`;
  }

  /**
   * Parse LLM response and match to videos
   */
  parseSearchResults(content, videosWithMetadata) {
    try {
      // Extract JSON from the response (in case there's extra text)
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn('No JSON array found in LLM response');
        return [];
      }

      const matches = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(matches)) {
        console.warn('LLM response is not an array');
        return [];
      }

      // Match the LLM results back to our video objects
      const results = [];
      for (const match of matches) {
        const video = this.findVideoByDateAndDuration(
          videosWithMetadata, 
          match.date, 
          match.duration
        );
        
        if (video) {
          results.push({
            ...video,
            searchReason: match.reason || 'LLM match'
          });
        }
      }

      return results;
    } catch (error) {
      console.error('Error parsing LLM response:', error);
      console.error('Raw response:', content);
      return [];
    }
  }

  /**
   * Find video by date and duration identifiers
   */
  findVideoByDateAndDuration(videos, targetDate, targetDuration) {
    return videos.find(video => {
      try {
        const metadata = JSON.parse(video.metadata);
        const videoDate = metadata.start ? new Date(metadata.start).toISOString() : video.added_date;
        const videoDuration = metadata.duration || 0;
        
        // Allow small duration differences (within 5 seconds)
        const durationMatch = Math.abs(videoDuration - targetDuration) <= 5;
        const dateMatch = videoDate === targetDate;
        
        return dateMatch && durationMatch;
      } catch (error) {
        return false;
      }
    });
  }
}

module.exports = OpenRouterClient;