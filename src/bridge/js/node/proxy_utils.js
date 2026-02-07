function makeLenientProxy(instance, fallbackReturn, options = {}) {
    const methodPattern = options.methodPattern instanceof RegExp
        ? options.methodPattern
        : /^(on[A-Z]|onlineStatus|dispatch|getGroupCode)/;
    const fallbackFns = new Map();

    const getFallback = (prop) => {
        if (!fallbackFns.has(prop)) {
            fallbackFns.set(prop, () => fallbackReturn);
        }
        return fallbackFns.get(prop);
    };

    return new Proxy(instance, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value === 'function') {
                return value.bind(target);
            }
            if (typeof prop === 'string' && methodPattern.test(prop)) {
                return getFallback(prop);
            }
            return value;
        },
        has(target, prop) {
            if (Reflect.has(target, prop)) {
                return true;
            }
            return typeof prop === 'string' && methodPattern.test(prop);
        },
    });
}

module.exports = {
    makeLenientProxy,
};
