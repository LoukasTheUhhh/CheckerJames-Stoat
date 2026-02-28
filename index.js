const { Client } = require("revolt.js");
const express = require('express');
const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('System Online - Bot is active.'));
app.listen(port, () => console.log(`Web server active on port ${port}`));

const client = new Client();
const INVITE_CACHE = new Map();
const PENDING_MGR = new Map();

const RANK_ORDER = ["Manager", "Boss", "Scientist", "Subject"];

function closestRole(input) {
    const match = RANK_ORDER.find(r => r.toLowerCase().startsWith(input.toLowerCase()));
    return match || null;
}

async function updateInvites(server) {
    try {
        const invites = await server.fetchInvites();
        invites.forEach(inv => {
            INVITE_CACHE.set(inv._id, { creatorId: inv.creator_id, uses: inv.uses || 0 });
        });
    } catch (e) {
        console.error(`Could not fetch invites for ${server.name || 'a server'}:`, e);
    }
}

client.on("ready", () => {
    console.log(`Logged in as ${client.user.username}`);
    setTimeout(async () => {
        for (const server of client.servers.values()) {
            await updateInvites(server);
        }
        console.log("Invite database cached.");
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
            let staffChannel = Array.from(server.channels.values())
                .find(c => c.name === "bot-roles");

            if (!staffChannel) {
                try {
                    staffChannel = await server.createChannel({
                        name: "bot-roles",
                        type: "TextChannel",
                        description: "Channel for bot role assignments",
                        permission_overwrites: []
                    });
                    console.log(`Created "bot-roles" channel in ${server.name}`);
                } catch (e) {
                    console.error(`Failed to create "bot-roles" in ${server.name}:`, e);
                }
            }

            if (staffChannel) {
                await staffChannel.sendMessage(
                    `<@${inviter.id}> invited <@${member.id}>! Reply with:\n!role <@${member.id}> [RoleName]`
                );
            }
            PENDING_MGR.set(inviter.id, { target: member.id, serverId: server.id });
        
        } else if (topRole === "Boss") await assign(member, "Scientist");
        else if (topRole === "Scientist") await assign(member, "Subject");
        else if (topRole === "Subject") await assign(member, "Visitor");

    } catch (err) {
        console.error("Join Event Error:", err);
    }
});

client.on("messageCreate", async (msg) => {
    if (msg.author_id === client.user.id) return;
    if (!msg.channel.server || msg.channel.name !== "bot-roles") return;
    if (!msg.content.startsWith("!role ")) return;

    const roleMatch = msg.content.match(/!role\s+<@!?(\w+)>\s+(.+)/);
    if (!roleMatch) return msg.channel.sendMessage("Usage: !role <@User> RoleName");

    const targetId = roleMatch[1];
    let requestedName = roleMatch[2].trim();
    
    const validRole = RANK_ORDER.includes(requestedName) ? requestedName : closestRole(requestedName);
    if (!validRole) return msg.channel.sendMessage(
        `Invalid role "${requestedName}". Valid roles: ${RANK_ORDER.join(", ")}`
    );

    const server = client.servers.get(msg.channel.server);
    if (!server) return;

    try {
        const targetMember = await server.fetchMember(targetId);
        await assign(targetMember, validRole);
        await msg.channel.sendMessage(`Success! Assigned '${validRole}' to ${targetMember.user.username}.`);
        PENDING_MGR.delete(msg.author_id);
    } catch (e) {
        console.error("Role assignment error:", e);
        await msg.channel.sendMessage("Error: Could not assign role. Check bot permissions.");
    }
});

async function assign(member, roleName) {
    const role = Array.from(member.server.roles.values()).find(r => r.name === roleName);
    if (!role) return;

    const currentRoles = member.roles || [];
    const currentRoleNames = Array.from(member.server.roles.values())
        .filter(r => currentRoles.includes(r.id))
        .map(r => r.name);

    const highestCurrentRoleIndex = RANK_ORDER.findIndex(r => currentRoleNames.includes(r));
    const newRoleIndex = RANK_ORDER.findIndex(r => r === roleName);

    if (newRoleIndex < 0) return;

    if (highestCurrentRoleIndex === -1 || newRoleIndex < highestCurrentRoleIndex) {
        await member.edit({ roles: [...currentRoles.filter(id => {
            const rName = Array.from(member.server.roles.values())
                .find(r => r.id === id)?.name;
            return !rName || RANK_ORDER.indexOf(rName) > newRoleIndex;
        }), role.id] });
    }
}

client.loginBot(process.env.TOKEN).catch(err => {
    console.error("CRITICAL LOGIN ERROR:", err.message);
});
