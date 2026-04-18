export function createSerializedTaskRunner() {
    let chain = Promise.resolve();

    return function run(task) {
        const execution = chain.then(() => task(), () => task());
        chain = execution.catch(() => {});
        return execution;
    };
}
