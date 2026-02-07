function envFlag(name, env = process.env, defaultValue = false) {
    const raw = env && Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return defaultValue;
    }

    const normalized = String(raw).trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
        return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
        return false;
    }
    return defaultValue;
}

function envInt(name, env = process.env) {
    const raw = env && Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return null;
    }

    const value = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(value)) {
        return null;
    }

    return value;
}

module.exports = {
    envFlag,
    envInt,
};
