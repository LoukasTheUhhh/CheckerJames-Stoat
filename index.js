const { Client } = require("revolt.js");
const express = require('express');
const app = express();

// --- 1. RENDER & UPTIME CONFIG ---
// Render requires the app to listen on process.env.PORT or it will think it crashed.
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('System Online - Bot is active.');
});

app.listen(port, () => {
    console.log(`Web server active on port ${port} for UptimeRobot.`);
});

// --- 2. REVOLT BOT LOGIC ---
const client = new Client();
const INVITE_CACHE = new Map(); 
const PENDING_MGR = new Map();

const RANK_ORDER = ["Manager", "Boss", "Scientist", "Subject"];

async function updateInvites(server) {
    try {
        const invites = await server.fetchInvites();
        invites.forEach(inv => {
            INVITE_CACHE.set(inv._id, { creatorId: inv.creator_id, uses: inv.uses || 0 });
        });
    } catch (e) { 
        console.log(`Notice: Could not fetch invites for ${server.name || 'a server'}.`); 
    }
}

client.on("ready", () => {
    console.log(`Logged in successfully as ${client.user.username}`);
    
    // Increased delay to 5s to ensure Render's network is fully stable on boot
    setTimeout(async () => {
        for (const server of client.servers.values()) {
            await updateInvites(server);
        }
        console.log("Invite database successfully cached.");
    }, 5000); 
});

client.on("memberJoined", async (member) => {
    const server = member.server;
    const oldCache = new Map(INVITE_CACHE);
    await updateInvites(server);

    let inviterId = null;
    for (const [id, data] of INVITE_CACHE) {
        const prev = oldCache.get(id);
        if (prev && data.uses > prev.uses) {
            inviterId = data.creatorId;
            break;
        }
    }

    if (!inviterId) return;

    try {
        const inviter = await server.fetchMember(inviterId);
        const inviterRoleNames = Array.from(server.roles.values())
            .filter(r => (inviter.roles || []).includes(r.id))
            .map(r => r.name);

        const topRole = RANK_ORDER.find(roleName => inviterRoleNames.includes(roleName));

        if (topRole === "Manager") {
            PENDING_MGR.set(inviter.id, { target: member.id, serverId: server.id });
            const dm = await inviter.user.openDM();
            await dm.sendMessage(`New join detected! Reply with **!role [Name]** to assign a rank.`);
        } 
        else if (topRole === "Boss") await assign(member, "Scientist");
        else if (topRole === "Scientist") await assign(member, "Subject");
        else if (topRole === "Subject") await assign(member, "Visitor");

    } catch (err) { console.error("Join Event Error:", err.message); }
});

client.on("message", async (msg) => {
    if (msg.author_id === client.user.id || msg.channel.channel_type !== "DirectMessage") return;
    
    const data = PENDING_MGR.get(msg.author_id);
    if (!data || !msg.content.startsWith("!role ")) return;

    const requestedName = msg.content.replace("!role ", "").trim();
    const server = client.servers.get(data.serverId);
    if (!server) return;

    try {
        const targetMember = await server.fetchMember(data.target);
        await assign(targetMember, requestedName);
        await msg.reply(`Success! Assigned ${requestedName} to ${targetMember.user.username}.`);
        PENDING_MGR.delete(msg.author_id);
    } catch (e) { await msg.reply("Error: Role not found or Bot role is too low."); }
});

async function assign(member, roleName) {
    const role = Array.from(member.server.roles.values()).find(r => r.name === roleName);
    if (role) {
        const currentRoles = member.roles || [];
        if (!currentRoles.includes(role.id)) {
            await member.edit({ roles: [...currentRoles, role.id] });
        }
    }
}

// Ensure you set the "TOKEN" in the Render Environment Variables tab!
client.loginBot(process.env.TOKEN).catch(err => {
    console.error("CRITICAL LOGIN ERROR:", err.message);
});
