// Migration endpoint with inline auth
export async function onRequestPost(context) {
  const { request, env } = context;
  
  // Manual auth check
  let sessionToken = request.headers.get('X-Session-Token');
  if (!sessionToken) {
    const cookie = request.headers.get('Cookie');
    sessionToken = cookie?.match(/session=([^;]+)/)?.[1];
  }
  
  if (!sessionToken) {
    return new Response(JSON.stringify({ 
      error: 'Authentication required' 
    }), { 
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Get session and user
  const session = await env.SESSIONS.get(`session:${sessionToken}`, 'json');
  if (!session) {
    return new Response(JSON.stringify({ 
      error: 'Invalid session' 
    }), { 
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const user = await env.USERS.get(`user:${session.email}`, 'json');
  if (!user || user.email !== 'vie@odysseus.bot') {
    return new Response(JSON.stringify({ 
      error: 'Access denied. Only vie@odysseus.bot can run migration.',
      userEmail: user?.email
    }), { 
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    // Get all bins
    const list = await env.BINS.list();
    let migratedCount = 0;
    let skippedCount = 0;
    const migrationResults = [];
    
    // Create odysseus-bot team if it doesn't exist
    const teamId = 'odysseus-bot';
    let team = await env.TEAMS.get(`team:${teamId}`, 'json');
    
    if (!team) {
      team = {
        id: teamId,
        name: 'Odysseus Bot',
        createdAt: new Date().toISOString(),
        members: ['vie@odysseus.bot', 'michael@odysseus.bot', 'jessica@odysseus.bot']
      };
      await env.TEAMS.put(`team:${teamId}`, JSON.stringify(team));
      migrationResults.push('Created odysseus-bot team');
    }
    
    // Ensure vie@odysseus.bot exists as admin with correct teamId
    const vieEmail = 'vie@odysseus.bot';
    let vieUser = await env.USERS.get(`user:${vieEmail}`, 'json');
    
    if (!vieUser) {
      vieUser = {
        id: crypto.randomUUID(),
        email: vieEmail,
        teamId: teamId,
        role: 'admin',
        createdAt: new Date().toISOString()
      };
      await env.USERS.put(`user:${vieEmail}`, JSON.stringify(vieUser));
      migrationResults.push('Created vie@odysseus.bot user');
    } else if (vieUser.teamId !== teamId) {
      // Update existing user's teamId if it doesn't match
      const oldTeamId = vieUser.teamId;
      vieUser.teamId = teamId;
      await env.USERS.put(`user:${vieEmail}`, JSON.stringify(vieUser));
      migrationResults.push(`Updated vie@odysseus.bot teamId from '${oldTeamId}' to '${teamId}'`);
    }
    
    // Process each bin
    for (const key of list.keys) {
      const bin = await env.BINS.get(key.name, 'json');
      
      if (bin && !bin.teamId) {
        // This is an old bin without team assignment
        bin.teamId = teamId;
        bin.createdBy = bin.createdBy || vieEmail;
        
        // Store with new key format
        const newKey = `bin:${teamId}:${bin.id}`;
        await env.BINS.put(newKey, JSON.stringify(bin));
        
        // Delete old key if different
        if (key.name !== newKey) {
          await env.BINS.delete(key.name);
        }
        
        migrationResults.push(`Migrated bin: ${bin.name} (${bin.id})`);
        migratedCount++;
      } else {
        skippedCount++;
      }
    }
    
    return new Response(JSON.stringify({
      success: true,
      message: `Migration complete. Migrated ${migratedCount} bins, skipped ${skippedCount} bins.`,
      results: migrationResults,
      team: team
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Migration error:', error);
    return new Response(JSON.stringify({ 
      error: 'Migration failed',
      details: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}