const API_BASE = 'https://api.bitbucket.org/2.0/repositories';
function getAuthHeader() {
    const token = process.env.BITBUCKET_TOKEN;
    if (token) {
        return `Bearer ${token}`;
    }
    const username = process.env.BITBUCKET_USERNAME;
    const appPassword = process.env.BITBUCKET_APP_PASSWORD;
    if (username && appPassword) {
        return `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;
    }
    return null;
}
async function fetchApi(url) {
    const auth = getAuthHeader();
    if (!auth)
        return null;
    try {
        const response = await fetch(url, {
            headers: { Authorization: auth },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok)
            return null;
        return (await response.json());
    }
    catch {
        return null;
    }
}
export class BitbucketProvider {
    name = 'bitbucket';
    displayName = 'Bitbucket';
    prTerminology = 'PR';
    prRefspec = null;
    detectFromRemote(url) {
        return url.includes('bitbucket.org');
    }
    async viewPR(number, owner, repo) {
        if (!Number.isInteger(number) || number < 1)
            return null;
        if (!owner || !repo)
            return null;
        const data = await fetchApi(`${API_BASE}/${owner}/${repo}/pullrequests/${number}`);
        if (!data)
            return null;
        const source = data.source;
        const dest = data.destination;
        const sourceBranch = source?.branch;
        const destBranch = dest?.branch;
        const links = data.links;
        const htmlLink = links?.html;
        const author = data.author;
        return {
            title: data.title,
            headBranch: sourceBranch?.name,
            baseBranch: destBranch?.name,
            url: htmlLink?.href,
            body: data.description,
            author: author?.display_name,
        };
    }
    async viewIssue(number, owner, repo) {
        if (!Number.isInteger(number) || number < 1)
            return null;
        if (!owner || !repo)
            return null;
        const data = await fetchApi(`${API_BASE}/${owner}/${repo}/issues/${number}`);
        if (!data)
            return null;
        const content = data.content;
        const links = data.links;
        const htmlLink = links?.html;
        return {
            title: data.title,
            body: content?.raw,
            url: htmlLink?.href,
        };
    }
    checkAuth() {
        return getAuthHeader() !== null;
    }
    getRequiredCLI() {
        return null;
    }
}
//# sourceMappingURL=bitbucket.js.map