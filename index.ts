import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as tls from "@pulumi/tls";
import { CloudHSMV2 } from "@aws-sdk/client-cloudhsm-v2";
import { fromIni } from "@aws-sdk/credential-provider-ini";

export = async () => {
    const config = new pulumi.Config("aws");
    const region = config.require("region");
    const profile = config.require("profile");

    const vpc = new awsx.ec2.Vpc("vpc", {
        cidrBlock: "10.100.0.0/16",
    });

    const cluster = new aws.cloudhsmv2.Cluster("cluster", {
        hsmType: "hsm1.medium",
        subnetIds: vpc.publicSubnetIds,
    });

    // Get the id for the latest Amazon Linux AMI
    const ami = await aws.ec2.getAmi({
        filters: [
            { name: "name", values: ["amzn-ami-hvm-*-x86_64-ebs"] },
        ],
        owners: ["137112412989"], // Amazon
        mostRecent: true,
    });

    // create a new security group for port 80
    const group = new aws.ec2.SecurityGroup("web-secgrp", {
        ingress: [
            { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] },
        ],
    });

    const privateKey = new tls.PrivateKey("pk", {
        algorithm: "RSA",
        rsaBits: 2048
    });

    const key = new aws.ec2.KeyPair("kp", {
        publicKey: privateKey.publicKeyOpenssh,
    });

    const instance = new aws.ec2.Instance("cluster-instance", {
        instanceType: aws.ec2.InstanceType.T2_Micro, // t2.micro is available in the AWS free tier
        vpcSecurityGroupIds: [ 
            group.id,
            cluster.securityGroupId, // gain access to the cluster instances
        ], 
        associatePublicIpAddress: true,
        ami: ami.id,
        keyName: key.keyName,
        subnetId: vpc.subnets.apply(subs => subs[0].id),
    });

    const hsm = new aws.cloudhsmv2.Hsm("hsm1", {
        clusterId: cluster.id,
        subnetId: vpc.publicSubnetIds.apply(subs => subs[0]),
    });

    // const hsm2 = new aws.cloudhsmv2.Hsm("hsm2", {
    //     clusterId: cluster.id,
    //     subnetId: vpc.publicSubnetIds.apply(subs => subs[0])
    // });

    const cloudhsm = new CloudHSMV2({
        region: region,
        credentials: fromIni({ profile: profile })
    });

    const clusterStatus = await getHsmClusterStatus(cloudhsm, cluster.id, "INITIALIZED");

    return {
        clusterState: clusterStatus.clusterStatus,
        clusterId: cluster.id,
    }
}

interface HsmClusterStatus {
    clusterId: pulumi.Output<string>;
    clusterStatus: pulumi.Output<string>;
}

async function initializeHsmCluster(hsm: CloudHSMV2, clusterId: pulumi.Output<string>) {
    const clusterCsr = clusterId.apply(async id => {
        const result = await hsm.describeClusters({
            Filters: {
                "clusterIds": [
                    id,
                ]
            }
        });

        const cluster = result.Clusters?.find(c => c.ClusterId == id);
        return cluster!.Certificates?.ClusterCsr!;
    });

    const privateKey = new tls.PrivateKey("cluster-pk", {
        algorithm: "RSA",
        rsaBits: 2048 
    });

    const clusterCert = new tls.SelfSignedCert("cluster-selfsigned", {
        privateKeyPem: privateKey.privateKeyPem,
        allowedUses: [
            "certSigning"
        ],
        validityPeriodHours: 24 * 365 * 10 // 10 years
    });

    
}

async function getHsmClusterStatus(hsm: CloudHSMV2, clusterId: pulumi.Output<string>, targetStatus: string, timeoutSeconds?: number): Promise<HsmClusterStatus> {
    if (!timeoutSeconds) {
        timeoutSeconds = 10 * 60
    }

    const clusterOutputs = clusterId.apply(async id => {
        // max allowed time is 20 mins per use of this func
        // could use some available packages but we will guessimate each loop takes 10 seconds w/ the sleep included
        const maxAttempts = 1 * 60 / 10; // 20 mins * 60 secs / 10 secs = 120 attempts
        let attempts = 0;
        while (true) {

            const result = await hsm.describeClusters({
                Filters: {
                    "clusterIds": [
                        id,
                    ]
                }
            });

            if (!result.Clusters) {
                console.log("No cluster found for given cluster id");
                throw new Error("Cluster not found");
            }

            const cluster = result.Clusters.find(cluster => cluster.ClusterId == id);
            if (!cluster) {
                console.log(`Unable to find cluster by id ${clusterId}`);
                throw new Error(`Unable to find cluster by id ${clusterId}`);
            }

            attempts++;
            if (cluster.State! == targetStatus) {
                return {
                    clusterStatus: cluster.State!,
                    clusterId: cluster.ClusterId!
                }
            } else {
                if (attempts > maxAttempts) {
                    throw new Error(`Unable to obtain cluster state ${targetStatus} in the alloted timeframe`);
                }

                console.log(`Cluster state ${cluster.State} does not match desired state of ${targetStatus}. Will retry...`);
                await sleep(10000); // 10 seconds
            }
        }
    });

    return {
        clusterId: clusterOutputs.clusterId,
        clusterStatus: clusterOutputs.clusterStatus
    };
}

async function sleep(ms: number) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}