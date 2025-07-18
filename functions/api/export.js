// Export dataset endpoint with inline auth
async function authenticate(request, env) {
  // Get session token
  let sessionToken = request.headers.get('X-Session-Token');
  if (!sessionToken) {
    const cookie = request.headers.get('Cookie');
    sessionToken = cookie?.match(/session=([^;]+)/)?.[1];
  }
  
  if (!sessionToken) {
    return { error: 'No session token', status: 401 };
  }
  
  // Get session from KV
  const session = await env.SESSIONS.get(`session:${sessionToken}`, 'json');
  if (!session) {
    return { error: 'Invalid session', status: 401 };
  }
  
  // Get user
  const user = await env.USERS.get(`user:${session.email}`, 'json');
  if (!user) {
    return { error: 'User not found', status: 401 };
  }
  
  return { user, session };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const binId = url.searchParams.get('binId');
  
  if (!binId) {
    return new Response(JSON.stringify({ error: 'Bin ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    // Authenticate
    const auth = await authenticate(request, env);
    if (auth.error) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const { user } = auth;
    
    // Try to find bin with team prefix
    let binKey = null;
    let binData = null;
    
    // First try with user's team
    if (user.teamId) {
      binKey = `bin:${user.teamId}:${binId}`;
      binData = await env.BINS.get(binKey, 'json');
    }
    
    // If not found, try without prefix (legacy format)
    if (!binData) {
      binData = await env.BINS.get(binId, 'json');
      if (binData) {
        binKey = binId;
      }
    }
    if (!binData) {
      return new Response(JSON.stringify({ error: 'Bin not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check access permissions
    if (binData.visibility === 'personal' && binData.createdBy !== user.email) {
      return new Response(JSON.stringify({ error: 'Access denied' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (binData.visibility === 'team' && binData.teamId !== user.teamId) {
      return new Response(JSON.stringify({ error: 'Access denied' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Get all conversations in the bin
    const list = await env.CONVERSATIONS.list({ prefix: `${binId}:` });
    const jsonlLines = [];
    
    for (const key of list.keys) {
      const convData = await env.CONVERSATIONS.get(key.name, 'json');
      if (convData) {
        // Format for OpenAI fine-tuning
        const formatted = {
          messages: convData.messages,
          metadata: convData.metadata
        };
        jsonlLines.push(JSON.stringify(formatted));
      }
    }
    
    const filename = `${binData.name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.jsonl`;
    
    return new Response(jsonlLines.join('\n'), {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}