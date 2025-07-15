// AI generation endpoint
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

// List of models that use Chain of Thought reasoning
const COT_MODELS = [
  'x-ai/grok-4',
  'gemini-2.5-pro',
  'models/gemini-2.5-pro',
  'deepseek/deepseek-r1'
];

// Function to check if a model uses COT
function isCOTModel(modelId) {
  return COT_MODELS.some(cotModel => modelId.includes(cotModel));
}

// Function to extract reasoning trace from COT response
function extractCOTContent(content, modelId) {
  // Different models use different formats for reasoning traces
  
  // Grok models typically use <thinking> tags
  if (modelId.includes('grok')) {
    const thinkingMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/);
    if (thinkingMatch) {
      const reasoning = thinkingMatch[1];
      const mainContent = content.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
      return { reasoning, mainContent, fullContent: content };
    }
  }
  
  // Deepseek R1 uses <reasoning> tags
  if (modelId.includes('deepseek')) {
    const reasoningMatch = content.match(/<reasoning>([\s\S]*?)<\/reasoning>/);
    if (reasoningMatch) {
      const reasoning = reasoningMatch[1];
      const mainContent = content.replace(/<reasoning>[\s\S]*?<\/reasoning>/, '').trim();
      return { reasoning, mainContent, fullContent: content };
    }
  }
  
  // Gemini might use different markers or none at all
  if (modelId.includes('gemini')) {
    // Check for common reasoning patterns
    const reasoningPatterns = [
      /^(Let me think[\s\S]*?)\n\n(?=\w)/,
      /^(I need to[\s\S]*?)\n\n(?=\w)/,
      /^(First,[\s\S]*?)\n\n(?=The answer|Based on|To answer)/
    ];
    
    for (const pattern of reasoningPatterns) {
      const match = content.match(pattern);
      if (match) {
        const reasoning = match[1];
        const mainContent = content.substring(reasoning.length).trim();
        return { reasoning, mainContent, fullContent: content };
      }
    }
  }
  
  // If no reasoning trace found, return content as-is
  return { reasoning: '', mainContent: content, fullContent: content };
}

// Function to estimate tokens for text (used when API doesn't provide counts)
function estimateTokens(text) {
  // Rough approximation: 1 token ≈ 4 characters
  return Math.ceil(text.length / 4);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  
  // Log request details for debugging
  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  
  // Set a timeout promise to prevent Cloudflare 524 errors (95 seconds to be safe)
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Request timeout - processing took too long')), 95000)
  );
  
  try {
    const { binId, systemPrompt, messages, models, temperature, maxTokens, max_completion_tokens, n } = await request.json();
    
    console.log(`[${timestamp}] Request ${requestId}:`, {
      binId,
      messageCount: messages?.length || 0,
      models: models || [],
      lastMessage: messages?.length > 0 ? messages[messages.length - 1].content.substring(0, 50) + '...' : 'none'
    });
    
    if (!binId || !messages || !models || models.length === 0) {
      return new Response(JSON.stringify({ error: 'Invalid request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Initialize AI clients
    const openai = env.OPENAI_API_KEY ? new OpenAI({
      apiKey: env.OPENAI_API_KEY
    }) : null;
    
    const anthropic = env.ANTHROPIC_API_KEY ? new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY
    }) : null;
    
    const google = env.GOOGLE_API_KEY ? new GoogleGenerativeAI(env.GOOGLE_API_KEY) : null;
    
    // Initialize OpenRouter client for Deepseek models
    const openrouter = env.OPENROUTER_API_KEY ? new OpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1'
    }) : null;
    
    // Generate responses in parallel - create N completions for each model
    const responsePromises = models.flatMap(modelId => 
      Array.from({ length: n || 1 }, (_, i) => generateSingleResponse(modelId, i))
    );
    
    // If we have too many requests, process in smaller batches to avoid timeouts
    const BATCH_SIZE = 6; // Process max 6 responses at a time
    let responses = [];
    
    if (responsePromises.length > BATCH_SIZE) {
      console.log(`[${timestamp}] Request ${requestId}: Processing ${responsePromises.length} responses in batches of ${BATCH_SIZE}`);
      
      for (let i = 0; i < responsePromises.length; i += BATCH_SIZE) {
        const batch = responsePromises.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch);
        responses.push(...batchResults);
        
        // Small delay between batches to prevent overwhelming the system
        if (i + BATCH_SIZE < responsePromises.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } else {
      // Process all at once if small enough
      responses = await Promise.all(responsePromises);
    }
    
    async function generateSingleResponse(modelId, completionIndex, retryCount = 0) {
      const maxRetries = 3;
      const retryDelay = (attempt) => Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff: 1s, 2s, 4s (max 5s)
      
      try {
        // Handle OpenAI models (including o3/o4-mini)
        if ((modelId.startsWith('gpt') || modelId.startsWith('o3') || modelId.startsWith('o4')) && openai) {
          const isO3Model = modelId.includes('o3') || modelId.includes('o4-mini');
          
          const params = {
            model: modelId,
            messages: [
              { role: 'system', content: systemPrompt },
              ...messages
            ],
            n: 1 // Always generate 1 at a time since we're calling multiple times
          };
          
          // Use appropriate parameters based on model type
          if (isO3Model) {
            params.max_completion_tokens = max_completion_tokens || maxTokens || 1000;
            // o3 models don't support temperature
          } else {
            params.temperature = temperature || 0.7;
            params.max_tokens = maxTokens || 1000;
          }
          
          const completion = await openai.chat.completions.create(params);
          
          const rawContent = completion.choices[0].message.content;
          let responseData = {
            model: modelId,
            content: rawContent,
            usage: completion.usage,
            completionIndex: completionIndex + 1,
            totalCompletions: n || 1
          };
          
          // Process COT models
          if (isCOTModel(modelId)) {
            const cotData = extractCOTContent(rawContent, modelId);
            responseData.content = cotData.mainContent;
            responseData.reasoning = cotData.reasoning;
            responseData.fullContent = cotData.fullContent;
            responseData.isCOT = true;
            
            // Adjust token counts to exclude reasoning
            if (completion.usage && cotData.reasoning) {
              const reasoningTokens = estimateTokens(cotData.reasoning);
              responseData.usage = {
                ...completion.usage,
                completion_tokens: Math.max(1, completion.usage.completion_tokens - reasoningTokens),
                total_tokens: Math.max(1, completion.usage.total_tokens - reasoningTokens)
              };
              responseData.reasoningTokens = reasoningTokens;
            }
          }
          
          return responseData;
        } else if (modelId.startsWith('claude') && anthropic) {
          const completion = await anthropic.messages.create({
            model: modelId,
            system: systemPrompt,
            messages: messages.map(m => ({
              role: m.role === 'user' ? 'user' : 'assistant',
              content: m.content
            })),
            temperature: temperature || 0.7,
            max_tokens: maxTokens || 1000
          });
          
          return {
            model: modelId,
            content: completion.content[0].text,
            usage: {
              prompt_tokens: completion.usage.input_tokens,
              completion_tokens: completion.usage.output_tokens,
              total_tokens: completion.usage.input_tokens + completion.usage.output_tokens
            },
            completionIndex: completionIndex + 1,
            totalCompletions: n || 1
          };
        } else if ((modelId.startsWith('deepseek') || modelId.startsWith('x-ai/grok') || modelId.startsWith('moonshotai')) && openrouter) {
          // Handle Deepseek, Grok, and Moonshotai models through OpenRouter
          const completion = await openrouter.chat.completions.create({
            model: modelId,
            messages: [
              { role: 'system', content: systemPrompt },
              ...messages
            ],
            temperature: temperature || 0.7,
            max_tokens: maxTokens || 1000
          });
          
          const rawContent = completion.choices[0].message.content;
          let responseData = {
            model: modelId,
            content: rawContent,
            usage: completion.usage,
            completionIndex: completionIndex + 1,
            totalCompletions: n || 1
          };
          
          // Process COT models (Grok 4, Deepseek R1)
          if (isCOTModel(modelId)) {
            const cotData = extractCOTContent(rawContent, modelId);
            responseData.content = cotData.mainContent;
            responseData.reasoning = cotData.reasoning;
            responseData.fullContent = cotData.fullContent;
            responseData.isCOT = true;
            
            // Adjust token counts to exclude reasoning
            if (completion.usage && cotData.reasoning) {
              const reasoningTokens = estimateTokens(cotData.reasoning);
              responseData.usage = {
                ...completion.usage,
                completion_tokens: Math.max(1, completion.usage.completion_tokens - reasoningTokens),
                total_tokens: Math.max(1, completion.usage.total_tokens - reasoningTokens)
              };
              responseData.reasoningTokens = reasoningTokens;
            }
          }
          
          return responseData;
        } else if ((modelId.includes('gemini') || modelId.startsWith('models/gemini')) && google) {
          // Handle Google Gemini models
          const modelName = modelId.replace('models/', ''); // Remove 'models/' prefix if present
          const model = google.getGenerativeModel({ model: modelName });
          
          // Combine system prompt with first user message for Gemini
          const combinedMessages = [...messages];
          if (systemPrompt && combinedMessages.length > 0 && combinedMessages[0].role === 'user') {
            combinedMessages[0] = {
              ...combinedMessages[0],
              content: `${systemPrompt}\n\n${combinedMessages[0].content}`
            };
          }
          
          // Convert messages to Gemini format
          const history = [];
          let currentPrompt = '';
          
          combinedMessages.forEach((msg, index) => {
            if (index === combinedMessages.length - 1 && msg.role === 'user') {
              currentPrompt = msg.content;
            } else {
              history.push({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
              });
            }
          });
          
          const chat = model.startChat({ history });
          const result = await chat.sendMessage(currentPrompt);
          const response = await result.response;
          
          const rawContent = response.text();
          let responseData = {
            model: modelId,
            content: rawContent,
            usage: {
              // Gemini doesn't provide token counts in the same way
              total_tokens: estimateTokens(currentPrompt + rawContent)
            },
            completionIndex: completionIndex + 1,
            totalCompletions: n || 1
          };
          
          // Process COT for Gemini
          if (isCOTModel(modelId)) {
            const cotData = extractCOTContent(rawContent, modelId);
            responseData.content = cotData.mainContent;
            responseData.reasoning = cotData.reasoning;
            responseData.fullContent = cotData.fullContent;
            responseData.isCOT = true;
            
            // Adjust estimated token counts
            if (cotData.reasoning) {
              const reasoningTokens = estimateTokens(cotData.reasoning);
              const mainContentTokens = estimateTokens(cotData.mainContent);
              const promptTokens = estimateTokens(currentPrompt);
              
              responseData.usage = {
                prompt_tokens: promptTokens,
                completion_tokens: mainContentTokens,
                total_tokens: promptTokens + mainContentTokens
              };
              responseData.reasoningTokens = reasoningTokens;
            }
          }
          
          return responseData;
        } else {
          return {
            model: modelId,
            error: 'Model not available'
          };
        }
      } catch (error) {
        console.error(`Error with ${modelId} (attempt ${retryCount + 1}/${maxRetries + 1}):`, error);
        
        // Retry logic with exponential backoff
        if (retryCount < maxRetries) {
          const delay = retryDelay(retryCount);
          console.log(`Retrying ${modelId} after ${delay}ms...`);
          
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delay));
          
          // Recursive retry
          return generateSingleResponse(modelId, completionIndex, retryCount + 1);
        }
        
        // After all retries failed
        return {
          model: modelId,
          error: `${error.message} (after ${maxRetries + 1} attempts)`,
          errorDetails: {
            message: error.message,
            attempts: retryCount + 1,
            modelId: modelId
          },
          completionIndex: completionIndex + 1,
          totalCompletions: n || 1
        };
      }
    }
    
    // The responses are already processed in batches above, so we just need to handle timeout
    // If we haven't finished by now, return what we have
    if (responses.length === 0) {
      console.warn(`[${timestamp}] Request ${requestId}: No responses generated`);
      responses = [{
        model: 'system',
        error: 'No responses generated - all models failed or timed out',
        errorDetails: {
          message: 'Generation failure',
          models: models
        }
      }];
    }
    
    // Log response summary
    const successCount = responses.filter(r => !r.error).length;
    console.log(`[${timestamp}] Request ${requestId} completed:`, {
      totalResponses: responses.length,
      successfulResponses: successCount,
      failedResponses: responses.length - successCount
    });
    
    return new Response(JSON.stringify({ responses }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error(`[${timestamp}] Request ${requestId} error:`, {
      error: error.message,
      stack: error.stack,
      models: models,
      messageCount: messages?.length
    });
    return new Response(JSON.stringify({ 
      error: error.message,
      details: {
        timestamp,
        requestId,
        models,
        messageCount: messages?.length
      }
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}