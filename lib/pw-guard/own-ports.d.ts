/** The run's own ports, as the box guard asks them. */
export declare function ownPorts(): {
    has(port: number): boolean;
};
/** A port a child server of this run answers on: the box guard allows it. */
export declare function boxOwnPort(port: number): void;
