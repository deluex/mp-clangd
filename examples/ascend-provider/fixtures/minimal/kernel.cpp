extern "C" __global__ __aicore__ __vector__ void probe_kernel(__gm__ float* x) {
    x[0] = 1.0f;
}
