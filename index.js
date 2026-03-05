const { Client } = require("revolt.js");
const express = require('express');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Online'));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(port);

const client = new Client();
const INVITE_CACHE = new Map();
const PENDING_MGR = new Map();
const RANK_ORDER = ["Manager", "Boss", "Scientist", "Subject", "Visitor"];

client.on("error", (err) => {
    console.error("Connection Error:", err.message);
});

function getRoleByName(server, name) {
    if (!server || !server.roles) return null;
    for (const role of server.roles.values()) {
        if (role && role.name === name) return role;
    }
    return null;
}

async function updateInvites(server) {
    try {
        const invites = await server.fetchInvites();
        for (const inv of invites) {
            INVITE_CACHE.set(inv._id, { creatorId: inv.creator_id, uses: inv.uses || 0, serverId: server._id });
        }
    } catch (e) {}
}

client.on("ready", () => {
    console.log("Active");
    setTimeout(async () => {
        for (const server of client.servers.values()) await updateInvites(server);
    }, 2000);
});

client.on("memberJoined", async (member) => {
    const server = member.server;
    if (!server) return;
    setTimeout(async () => {
        let inviterId = null;
        try {
            const freshInvites = await server.fetchInvites();
            for (const inv of freshInvites) {
                const cached = INVITE_CACHE.get(inv._id);
                const currentUses = inv.uses || 0;
                if (cached && currentUses > cached.uses) inviterId = cached.creatorId;
                INVITE_CACHE.set(inv._id, { creatorId: inv.creator_id, uses: currentUses, serverId: server._id });
            }
        } catch (e) { return; }
        if (!inviterId) return;
        try {
            const inviter = await server.fetchMember(inviterId);
            const inviterRoles = inviter.roles || [];
            let topRole = null;
            for (const roleName of RANK_ORDER) {
                const roleObj = getRoleByName(server, roleName);
                if (roleObj && inviterRoles.includes(roleObj.id)) { topRole = roleName; break; }
            }
            const memberId = member._id || member.user_id;
            if (topRole === "Manager") {
                let staffChannel = [...server.channels.values()].find(c => c.name === "bot-roles");
                if (!staffChannel) staffChannel = await server.createChannel({ name: "bot-roles", type: "TextChannel" });
                await staffChannel.sendMessage(`<@${inviterId}> invited <@${memberId}>! Reply with: !role <@${memberId}> [Role]`);
                if (PENDING_MGR.has(inviterId)) {
                    clearTimeout(PENDING_MGR.get(inviterId).timeout);
                }
                PENDING_MGR.set(inviterId, { target: memberId, timeout: setTimeout(() => PENDING_MGR.delete(inviterId), 3600000) });
            } else if (topRole) {
                const index = RANK_ORDER.indexOf(topRole);
                if (index >= 0 && index < RANK_ORDER.length - 1) await assign(member, RANK_ORDER[index + 1]);
            }
        } catch (err) {}
    }, 1500); 
});

client.on("messageCreate", async (msg) => {
    if (msg.author_id === client.user.id || !msg.content || !msg.content.startsWith("!role ")) return;
    const server = msg.channel.server;
    if (!server || msg.channel.name !== "bot-roles") return;
    const match = msg.content.match(/!role\s+<@([A-Z0-9]+)>\s+(.+)/i);
    if (!match || !match[1] || !match[2]) return;
    const targetId = match[1];
    const roleInput = match[2].trim();
    const validRole = RANK_ORDER.find(r => r.toLowerCase().startsWith(roleInput.toLowerCase()));
    if (!validRole) return;
    try {
        const targetMember = await server.fetchMember(targetId);
        await assign(targetMember, validRole);
        msg.channel.sendMessage(`Success.`);
        const pending = PENDING_MGR.get(msg.author_id);
        if (pending) { clearTimeout(pending.timeout); PENDING_MGR.delete(msg.author_id); }
    } catch (e) {}
});

async function assign(member, roleName) {
    const role = getRoleByName(member.server, roleName);
    if (!role) return;
    const currentRoles = member.roles || [];
    if (!currentRoles.includes(role.id)) {
        const rankRoleIds = [];
        for (const rName of RANK_ORDER) {
            const rObj = getRoleByName(member.server, rName);
            if (rObj) rankRoleIds.push(rObj.id);
        }
        const filteredRoles = currentRoles.filter(id => !rankRoleIds.includes(id));
        await member.edit({ roles: [...filteredRoles, role.id] });
    }
}

client.on("serverDeleted", (serverId) => {
    for (const [id, data] of INVITE_CACHE) if (data.serverId === serverId) INVITE_CACHE.delete(id);
});

client.loginBot(process.env.TOKEN).catch(err => console.error(err.message));
